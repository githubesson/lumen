package integration

import (
	"context"
	"os"
	"reflect"
	"testing"

	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/users"
	"github.com/google/uuid"
)

// Use a disposable database: this check migrates it and installs a temporary
// failure trigger to prove that password updates roll back with session deletion.
func TestReviewDatabaseFixes(t *testing.T) {
	url := os.Getenv("LUMEN_REVIEW_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set LUMEN_REVIEW_TEST_DATABASE_URL to an isolated PostgreSQL database")
	}
	if err := db.Migrate(url); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	pool, err := db.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	exec := func(t *testing.T, sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	userID := uuid.New()
	exec(t, `INSERT INTO users(id,username,password_hash,role,must_reset_password) VALUES($1,$2,'old','user',TRUE)`, userID, "review-"+userID.String())
	defer pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
	exec(t, `INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '1 day')`, []byte(userID.String()), userID)
	store := users.NewStore(pool)

	t.Run("password and session revocation are atomic", func(t *testing.T) {
		exec(t, `CREATE FUNCTION review_reject_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected session deletion failure'; END $$`)
		defer pool.Exec(ctx, `DROP FUNCTION review_reject_session_delete() CASCADE`)
		exec(t, `CREATE TRIGGER review_reject_session_delete BEFORE DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION review_reject_session_delete()`)
		if err := store.ChangePassword(ctx, userID, "old", "new"); err == nil {
			t.Fatal("expected deletion failure")
		}
		user, err := store.ByID(ctx, userID)
		if err != nil {
			t.Fatal(err)
		}
		if user.PasswordHash != "old" || !user.MustResetPassword {
			t.Fatal("failed revocation committed the password change")
		}
		exec(t, `DROP TRIGGER review_reject_session_delete ON sessions`)
		if err := store.ChangePassword(ctx, userID, "old", "new"); err != nil {
			t.Fatal(err)
		}
		user, err = store.ByID(ctx, userID)
		if err != nil {
			t.Fatal(err)
		}
		if user.PasswordHash != "new" || user.MustResetPassword {
			t.Fatal("password not updated")
		}
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE user_id=$1`, userID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatal("sessions survived password change")
		}
		if err := store.ChangePassword(ctx, userID, "old", "stale"); err == nil {
			t.Fatal("stale password verification was accepted")
		}
	})

	t.Run("sort precedes pagination with and without a search filter", func(t *testing.T) {
		for i, title := range []string{"review Charlie", "review alpha", "review Bravo"} {
			exec(t, `INSERT INTO tracks(id,owner_id,title,duration_ms,file_path,file_size,format,audio_sha256,created_at) VALUES($1,$2,$3,$4,$3,1,'mp3',$5,NOW()+$4::integer*INTERVAL '1 second')`, uuid.New(), userID, title, i+1, []byte(title))
		}
		lib := library.NewStore(pool)
		for _, query := range []string{"", "review"} {
			for _, sort := range []string{"recent", "title", "artist", "album", "duration"} {
				params := library.ListTracksParams{ViewerID: userID, Sort: sort, Query: query, Limit: 2}
				first, err := lib.ListTracks(ctx, params)
				if err != nil {
					t.Fatalf("sort %s, query %q: %v", sort, query, err)
				}
				params.Offset = 2
				second, err := lib.ListTracks(ctx, params)
				if err != nil {
					t.Fatal(err)
				}
				if len(first) != 2 || len(second) != 1 {
					t.Fatalf("unexpected pages: %d/%d", len(first), len(second))
				}
				params.Offset = 0
				params.Limit = 100
				full, err := lib.ListTracks(ctx, params)
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(append(first, second...), full) {
					t.Fatalf("unstable %s pagination", sort)
				}
				if sort == "title" && (full[0].Title != "review alpha" || full[2].Title != "review Charlie") {
					t.Fatal("title sorting did not cover the full result set")
				}
			}
		}
	})
}
