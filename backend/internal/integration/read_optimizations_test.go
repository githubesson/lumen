package integration

import (
	"context"
	"os"
	"reflect"
	"sync/atomic"
	"testing"

	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/playlists"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type readQueryCounter struct{ queries atomic.Int64 }

func (c *readQueryCounter) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	c.queries.Add(1)
	return ctx
}

func (*readQueryCounter) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestReadOptimizations(t *testing.T) {
	url := os.Getenv("LUMEN_REVIEW_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set LUMEN_REVIEW_TEST_DATABASE_URL to an isolated PostgreSQL database")
	}
	if err := db.Migrate(url); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	counter := &readQueryCounter{}
	cfg.ConnConfig.Tracer = counter
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	viewer, owner := uuid.New(), uuid.New()
	for _, id := range []uuid.UUID{viewer, owner} {
		exec(`INSERT INTO users(id, username, password_hash, role) VALUES($1,$2,'test','user')`, id, "read-"+id.String())
		defer pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, id)
	}
	lib := library.NewStore(pool)
	pl := playlists.NewStore(pool)

	t.Run("playlist roles and visibility in one query", func(t *testing.T) {
		want := map[uuid.UUID]string{}
		for _, tc := range []struct {
			owner      uuid.UUID
			visibility playlists.Visibility
			role       string
			status     string
			want       string
		}{
			{viewer, playlists.VisibilityPrivate, "", "", "owner"},
			{viewer, playlists.VisibilityCollaborative, "viewer", "accepted", "owner"},
			{owner, playlists.VisibilityCollaborative, "editor", "accepted", "editor"},
			{owner, playlists.VisibilityCollaborative, "viewer", "accepted", "viewer"},
			{owner, playlists.VisibilityCollaborative, "editor", "pending", ""},
			{owner, playlists.VisibilityPrivate, "editor", "accepted", ""},
			{owner, playlists.VisibilityCollaborative, "", "", ""},
		} {
			p, err := pl.Create(ctx, tc.owner, "test", "", tc.visibility)
			if err != nil {
				t.Fatal(err)
			}
			defer pl.Delete(ctx, p.ID)
			if tc.role != "" {
				exec(`INSERT INTO playlist_collaborators(playlist_id,user_id,role,status) VALUES($1,$2,$3,$4)`, p.ID, viewer, tc.role, tc.status)
			}
			if tc.want != "" {
				want[p.ID] = tc.want
			}
		}
		counter.queries.Store(0)
		rows, err := pl.ListForUser(ctx, viewer)
		if err != nil {
			t.Fatal(err)
		}
		if n := counter.queries.Load(); n != 1 {
			t.Fatalf("playlist list used %d queries", n)
		}
		got := map[uuid.UUID]string{}
		for _, row := range rows {
			got[row.ID] = row.EffectiveRole
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("roles = %v, want %v", got, want)
		}
	})

	tracks := make([]uuid.UUID, 5)
	for i := range tracks {
		tracks[i] = uuid.New()
		exec(`INSERT INTO tracks(id,title,duration_ms,file_path,file_size,format,audio_sha256) VALUES($1,'test',1000,$2,1,'mp3',$3)`, tracks[i], tracks[i].String(), tracks[i][:])
		defer pool.Exec(ctx, `DELETE FROM tracks WHERE id=$1`, tracks[i])
	}
	exec(`UPDATE tracks SET owner_id=$2 WHERE id=$1`, tracks[3], owner)
	exec(`UPDATE tracks SET deleted_at=NOW() WHERE id=$1`, tracks[4])

	t.Run("favorites only include requested IDs for the viewer", func(t *testing.T) {
		for _, id := range tracks[:2] {
			if err := lib.SetFavorite(ctx, viewer, id, true); err != nil {
				t.Fatal(err)
			}
		}
		if err := lib.SetFavorite(ctx, owner, tracks[2], true); err != nil {
			t.Fatal(err)
		}
		for _, ids := range [][]uuid.UUID{nil, {}, {tracks[0]}, {tracks[0], tracks[0], tracks[2], uuid.New()}} {
			counter.queries.Store(0)
			got, err := lib.FavoriteIDs(ctx, viewer, ids)
			if err != nil {
				t.Fatal(err)
			}
			want := map[uuid.UUID]struct{}{}
			var wantQueries int64
			if len(ids) > 0 {
				want[tracks[0]] = struct{}{}
				wantQueries = 1
			}
			if !reflect.DeepEqual(got, want) || counter.queries.Load() != wantQueries {
				t.Fatalf("IDs %v: favorites %v, queries %d", ids, got, counter.queries.Load())
			}
		}
	})

	t.Run("repair legacy counts and preserve playlist behavior", func(t *testing.T) {
		for i := 0; i < 3; i++ {
			if err := lib.RecordPlay(ctx, viewer, tracks[0], 1); err != nil {
				t.Fatal(err)
			}
		}
		if err := lib.RecordPlay(ctx, owner, tracks[0], 1); err != nil {
			t.Fatal(err)
		}
		// Incorrect count, count with no history, and history missing a stats row.
		exec(`UPDATE user_track_stats SET play_count=99, rating=4 WHERE user_id=$1 AND track_id=ANY($2::uuid[])`, viewer, tracks[:2])
		exec(`INSERT INTO play_history(user_id,track_id,completion) VALUES($1,$2,1)`, viewer, tracks[2])
		migration, err := os.ReadFile("../db/migrations/0018_reconcile_play_counts.up.sql")
		if err != nil {
			t.Fatal(err)
		}
		// Execute the same multi-statement SQL used by the migration driver.
		exec(string(migration))
		for i, want := range []int{3, 0, 1} {
			var count int
			var favorite bool
			var rating *int
			var lastPlayed *string
			if err := pool.QueryRow(ctx, `SELECT play_count,favorited,rating,last_played_at::text FROM user_track_stats WHERE user_id=$1 AND track_id=$2`, viewer, tracks[i]).Scan(&count, &favorite, &rating, &lastPlayed); err != nil {
				t.Fatal(err)
			}
			if count != want || (i < 2 && (!favorite || rating == nil || *rating != 4)) || (i == 2 && lastPlayed == nil) {
				t.Fatalf("track %d: count=%d favorite=%t rating=%v lastPlayed=%v", i, count, favorite, rating, lastPlayed)
			}
		}
		if err := lib.RecordPlay(ctx, viewer, tracks[0], 1); err != nil {
			t.Fatal(err)
		}
		p, err := pl.Create(ctx, viewer, "counts", "", playlists.VisibilityPrivate)
		if err != nil {
			t.Fatal(err)
		}
		defer pl.Delete(ctx, p.ID)
		ids := append(append([]uuid.UUID{}, tracks...), tracks[0])
		if err := pl.AddTracks(ctx, p.ID, ids, viewer); err != nil {
			t.Fatal(err)
		}
		counter.queries.Store(0)
		rows, err := pl.TracksDetailed(ctx, p.ID, viewer)
		if err != nil {
			t.Fatal(err)
		}
		if counter.queries.Load() != 1 || len(rows) != 4 {
			t.Fatalf("playlist rows=%d queries=%d", len(rows), counter.queries.Load())
		}
		for i, want := range []int{4, 0, 1, 4} {
			if rows[i].PlayCount != want {
				t.Fatalf("row %d: count=%d, want %d", i, rows[i].PlayCount, want)
			}
		}
	})
}
