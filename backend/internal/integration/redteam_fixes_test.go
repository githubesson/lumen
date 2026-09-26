package integration

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/storage"
)

func openRedteamDB(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
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
	t.Cleanup(pool.Close)
	return ctx, pool
}

func redteamUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id, username, password_hash, role) VALUES($1,$2,'test','user')`,
		id, "redteam-"+id.String()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, id) })
	return id
}

func redteamTrack(t *testing.T, ctx context.Context, pool *pgxpool.Pool, owner *uuid.UUID, albumID *uuid.UUID) uuid.UUID {
	t.Helper()
	name := uuid.NewString()
	sha := sha256.Sum256([]byte(name))
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	id, _, _, err := library.InsertTrack(ctx, tx, library.TrackInsert{
		OwnerID: owner, AlbumID: albumID, Title: "Redteam " + name, DurationMS: 1000,
		FilePath: "/music/" + name + ".mp3", FileSize: 1, Format: "mp3", AudioSHA256: sha[:],
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM tracks WHERE id=$1`, id) })
	return id
}

func redteamAlbum(t *testing.T, ctx context.Context, pool *pgxpool.Pool, cover string, owner *uuid.UUID) uuid.UUID {
	t.Helper()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	id, err := library.UpsertAlbum(ctx, tx, "redteam-album-"+uuid.NewString(), nil, 0, false, cover, owner)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM albums WHERE id=$1`, id) })
	return id
}

// Write endpoints resolve client-supplied track ids through CheckTrackVisible;
// another user's upload must look exactly like a missing track.
func TestCheckTrackVisibleHidesOtherUsersUploads(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	attacker, victim := redteamUser(t, ctx, pool), redteamUser(t, ctx, pool)

	private := redteamTrack(t, ctx, pool, &victim, nil)
	global := redteamTrack(t, ctx, pool, nil, nil)

	if err := lib.CheckTrackVisible(ctx, private, attacker); !errors.Is(err, library.ErrNotFound) {
		t.Fatalf("attacker sees victim's upload: err=%v", err)
	}
	if err := lib.CheckTrackVisible(ctx, uuid.New(), attacker); !errors.Is(err, library.ErrNotFound) {
		t.Fatalf("missing track: err=%v, want ErrNotFound", err)
	}
	if err := lib.CheckTrackVisible(ctx, private, victim); err != nil {
		t.Fatalf("owner cannot see own upload: %v", err)
	}
	if err := lib.CheckTrackVisible(ctx, global, attacker); err != nil {
		t.Fatalf("global track hidden: %v", err)
	}

	removed := redteamTrack(t, ctx, pool, nil, nil)
	if _, err := pool.Exec(ctx, `UPDATE tracks SET deleted_at = NOW() WHERE id = $1`, removed); err != nil {
		t.Fatal(err)
	}
	if err := lib.CheckTrackVisible(ctx, removed, attacker); !errors.Is(err, library.ErrNotFound) {
		t.Fatalf("soft-deleted track: err=%v, want ErrNotFound", err)
	}
}

func TestDeletePersonalTrackDropsPersonalCoverWithLastTrack(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	user := redteamUser(t, ctx, pool)
	albumID := redteamAlbum(t, ctx, pool, "covers/redteam-"+uuid.NewString()+".jpg", &user)
	first := redteamTrack(t, ctx, pool, &user, &albumID)
	second := redteamTrack(t, ctx, pool, &user, &albumID)

	hasCover := func() bool {
		t.Helper()
		var ok bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM album_personal_covers WHERE album_id=$1 AND user_id=$2)`,
			albumID, user).Scan(&ok); err != nil {
			t.Fatal(err)
		}
		return ok
	}
	if !hasCover() {
		t.Fatal("personal cover row was not created")
	}
	if _, err := lib.DeletePersonalTrack(ctx, first, user); err != nil {
		t.Fatal(err)
	}
	if !hasCover() {
		t.Fatal("personal cover dropped while the user still has a track in the album")
	}
	if _, err := lib.DeletePersonalTrack(ctx, second, user); err != nil {
		t.Fatal(err)
	}
	if hasCover() {
		t.Fatal("personal cover kept after the user's last track in the album was deleted")
	}
}

func TestSweepOrphanCovers(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	root := t.TempDir()
	svc := &ingest.Service{DB: pool, Storage: storage.NewLocal(root), MusicRoot: root}

	referenced := "covers/redteam-ref-" + uuid.NewString() + ".jpg"
	orphan := "covers/redteam-orphan-" + uuid.NewString() + ".jpg"
	fresh := "covers/redteam-fresh-" + uuid.NewString() + ".jpg"
	orphanThumb := "cover-thumbs/512/" + orphan[:len(orphan)-len(".jpg")] + ".jpg"
	refThumb := "cover-thumbs/512/" + referenced[:len(referenced)-len(".jpg")] + ".jpg"
	redteamAlbum(t, ctx, pool, referenced, nil)

	old := time.Now().Add(-2 * time.Hour)
	for _, key := range []string{referenced, orphan, fresh, orphanThumb, refThumb} {
		p := filepath.Join(root, filepath.FromSlash(key))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if key != fresh {
			if err := os.Chtimes(p, old, old); err != nil {
				t.Fatal(err)
			}
		}
	}

	// A personal cover row with no track of its user in the album (what a
	// deduplicated personal upload leaves behind) must not pin its cover.
	user := redteamUser(t, ctx, pool)
	deadAlbum := redteamAlbum(t, ctx, pool, orphan, &user)
	if _, err := pool.Exec(ctx, `UPDATE album_personal_covers SET created_at = $1 WHERE album_id = $2`, old, deadAlbum); err != nil {
		t.Fatal(err)
	}

	removed, err := svc.SweepOrphanCovers(ctx, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 2 {
		t.Fatalf("removed %d objects, want 2 (orphan + its thumbnail)", removed)
	}
	var deadRow bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM album_personal_covers WHERE album_id = $1)`, deadAlbum).Scan(&deadRow); err != nil {
		t.Fatal(err)
	}
	if deadRow {
		t.Fatal("personal cover row without a surviving track was kept")
	}
	for key, want := range map[string]bool{referenced: true, fresh: true, refThumb: true, orphan: false, orphanThumb: false} {
		_, err := os.Stat(filepath.Join(root, filepath.FromSlash(key)))
		if exists := err == nil; exists != want {
			t.Fatalf("%s exists=%v, want %v", key, exists, want)
		}
	}
}

// Deleting a user's last two tracks in an album at the same moment must still
// drop their personal cover row.
func TestConcurrentLastTrackDeletesDropPersonalCover(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	user := redteamUser(t, ctx, pool)
	for round := range 10 {
		albumID := redteamAlbum(t, ctx, pool, "covers/redteam-race-"+uuid.NewString()+".jpg", &user)
		a := redteamTrack(t, ctx, pool, &user, &albumID)
		b := redteamTrack(t, ctx, pool, &user, &albumID)

		var wg sync.WaitGroup
		errs := make(chan error, 2)
		for _, id := range []uuid.UUID{a, b} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, err := lib.DeletePersonalTrack(ctx, id, user)
				errs <- err
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatal(err)
			}
		}
		var kept bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM album_personal_covers WHERE album_id=$1 AND user_id=$2)`,
			albumID, user).Scan(&kept); err != nil {
			t.Fatal(err)
		}
		if kept {
			t.Fatalf("round %d: personal cover row survived both deletes", round)
		}
	}
}
