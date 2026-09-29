package integration

import (
	"context"
	"encoding/binary"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/storage"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestCatalogPagesPreserveMetadataOrderAndVisibility(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	viewer, other := redteamUser(t, ctx, pool), redteamUser(t, ctx, pool)
	lib := library.NewStore(pool)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	albums := []uuid.UUID{redteamAlbum(t, ctx, pool, "", nil), redteamAlbum(t, ctx, pool, "", nil)}
	exec(`UPDATE albums SET title='Zed' WHERE id=$1`, albums[0])
	exec(`UPDATE albums SET title='Alpha' WHERE id=$1`, albums[1])
	var ids []uuid.UUID
	artists := []string{"Bravo, Alpha", "Zulu", "Charlie"}
	for i, title := range []string{"Zeta", "alpha", "Beta"} {
		var album *uuid.UUID
		if i < 2 {
			album = &albums[i]
		}
		id := redteamTrack(t, ctx, pool, &viewer, album)
		ids = append(ids, id)
		exec(`UPDATE tracks SET title=$2, duration_ms=$3, created_at=$4 WHERE id=$1`,
			id, "optimization "+title, []int{3000, 1000, 2000}[i], time.Date(2020, 1, i+1, 0, 0, 0, 0, time.UTC))
		for position, name := range strings.Split(artists[i], ", ") {
			artist := uuid.New()
			exec(`INSERT INTO artists(id,name) VALUES($1,$2)`, artist, name)
			t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM artists WHERE id=$1`, artist) })
			exec(`INSERT INTO track_artists(track_id,artist_id,position) VALUES($1,$2,$3)`, id, artist, position)
		}
		exec(`INSERT INTO track_aliases(track_id,file_path,title) VALUES($1,$2,'Alias only')`, id, id.String())
	}
	for i := range 3 {
		owner := &viewer
		if i == 0 {
			owner = &other
		}
		id := redteamTrack(t, ctx, pool, owner, nil)
		exec(`UPDATE tracks SET title='optimization invisible', created_at=NOW() WHERE id=$1`, id)
		if i == 1 {
			exec(`UPDATE tracks SET deleted_at=NOW() WHERE id=$1`, id)
		}
		if i == 2 {
			exec(`UPDATE tracks SET library_visible=FALSE WHERE id=$1`, id)
		}
	}
	for order, indexes := range map[string][]int{
		"recent": {2, 1, 0}, "title": {1, 2, 0}, "duration": {1, 2, 0},
		"album": {2, 1, 0}, "artist": {0, 2, 1},
	} {
		for _, query := range []string{"", "optimization", "Alias only"} {
			var got []uuid.UUID
			for offset := range 3 {
				rows, err := lib.ListTracks(ctx, library.ListTracksParams{ViewerID: viewer, Sort: order, Query: query, Limit: 1, Offset: offset})
				if err != nil || len(rows) != 1 {
					t.Fatalf("sort=%s query=%q offset=%d: %+v, %v", order, query, offset, rows, err)
				}
				wantIndex := indexes[offset]
				row := rows[0]
				if row.ID != ids[wantIndex] || row.Artist != artists[wantIndex] || row.Aka != "Alias only" || !row.Owned {
					t.Fatalf("sort=%s query=%q offset=%d lost metadata/order: %+v", order, query, offset, row)
				}
				got = append(got, row.ID)
			}
			if len(got) != 3 {
				t.Fatal("missing visible rows")
			}
		}
		// Search chooses matching tracks while preserving all primary artists.
		// Alpha matches an artist on one track and an album on another.
		for query, matched := range map[string]map[int]bool{
			"Bravo": {0: true}, "Alpha": {0: true, 1: true},
		} {
			offset := 0
			for _, index := range indexes {
				if !matched[index] {
					continue
				}
				rows, err := lib.ListTracks(ctx, library.ListTracksParams{ViewerID: viewer, Sort: order, Query: query, Limit: 1, Offset: offset})
				if err != nil || len(rows) != 1 || rows[0].ID != ids[index] || rows[0].Artist != artists[index] {
					t.Fatalf("search sort=%s query=%q offset=%d: %+v, %v", order, query, offset, rows, err)
				}
				offset++
			}
			count, err := lib.CountTracks(ctx, viewer, query)
			if err != nil || count != int64(len(matched)) {
				t.Fatalf("count query=%q = %d, %v", query, count, err)
			}
		}
	}
}

func TestRecentTimestampRepairAndReplayQueries(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	viewer, other := redteamUser(t, ctx, pool), redteamUser(t, ctx, pool)
	lib := library.NewStore(pool)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	played := redteamTrack(t, ctx, pool, &viewer, nil)
	remote := redteamTrack(t, ctx, pool, nil, nil)
	favorite := redteamTrack(t, ctx, pool, &viewer, nil)
	private := redteamTrack(t, ctx, pool, &other, nil)
	deleted := redteamTrack(t, ctx, pool, &viewer, nil)
	exec(`UPDATE tracks SET source='tidal',external_id=$2,library_visible=FALSE WHERE id=$1`, remote, uuid.NewString())
	exec(`UPDATE tracks SET deleted_at=NOW() WHERE id=$1`, deleted)
	old, newer := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2020, 2, 1, 0, 0, 0, 0, time.UTC)
	exec(`INSERT INTO play_history(user_id,track_id,played_at) VALUES($1,$2,$3),($1,$2,$4)`, viewer, played, old, newer)
	for _, id := range []uuid.UUID{remote, private, deleted} {
		exec(`INSERT INTO play_history(user_id,track_id,played_at) VALUES($1,$2,$3)`, viewer, id, newer.Add(time.Hour))
	}
	exec(`INSERT INTO user_track_stats(user_id,track_id,play_count,last_played_at,favorited,rating)
		VALUES($1,$2,2,$3,TRUE,4),($1,$4,0,$3,TRUE,5)`, viewer, played, old, favorite)
	// Run the actual timestamp repair against legacy rows.
	migration, err := os.ReadFile("../db/migrations/0023_recent_track_timestamps.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	exec(string(migration))
	var at *time.Time
	var favorited bool
	var rating, plays int
	if err := pool.QueryRow(ctx, `SELECT last_played_at,favorited,rating,play_count FROM user_track_stats WHERE user_id=$1 AND track_id=$2`, viewer, played).
		Scan(&at, &favorited, &rating, &plays); err != nil || at == nil || !at.Equal(newer) || !favorited || rating != 4 || plays != 2 {
		t.Fatalf("repaired stats = %v/%v/%d/%d: %v", at, favorited, rating, plays, err)
	}
	if err := pool.QueryRow(ctx, `SELECT last_played_at,favorited,rating FROM user_track_stats WHERE user_id=$1 AND track_id=$2`, viewer, favorite).
		Scan(&at, &favorited, &rating); err != nil || at != nil || !favorited || rating != 5 {
		t.Fatalf("favorite-only stats = %v/%v/%d: %v", at, favorited, rating, err)
	}
	rows, err := lib.ListRecent(ctx, viewer, 1)
	if err != nil || len(rows) != 1 || rows[0].ID != remote {
		t.Fatalf("recent page did not filter visibility before pagination: %+v, %v", rows, err)
	}
	if err := lib.RecordPlay(ctx, viewer, played, 0.5); err != nil {
		t.Fatal(err)
	}
	rows, err = lib.ListRecent(ctx, viewer, 10)
	if err != nil || len(rows) != 2 || rows[0].ID != played || rows[1].ID != remote {
		t.Fatalf("recent after playback = %+v, %v", rows, err)
	}
	artist := uuid.New()
	exec(`INSERT INTO artists(id,name) VALUES($1,$2)`, artist, "replay-"+artist.String())
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM artists WHERE id=$1`, artist) })
	exec(`INSERT INTO track_artists(track_id,artist_id) VALUES($1,$2)`, played, artist)
	counter := &readQueryCounter{}
	cfg := pool.Config().Copy()
	cfg.ConnConfig.Tracer = counter
	traced, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(traced.Close)
	data, err := library.NewStore(traced).ReplayStats(ctx, library.ReplayStatsParams{ViewerID: viewer})
	if err != nil {
		t.Fatal(err)
	}
	if counter.queries.Load() != 8 || data.Summary.HeadlineArtist == nil || data.Summary.HeadlineArtist.ID != artist ||
		data.Summary.HeadlineArtist.Plays != 3 || data.Summary.TotalPlays != 4 || data.Summary.TotalMs != 3500 {
		t.Fatalf("Replay: summary=%+v, queries=%d", data.Summary, counter.queries.Load())
	}
}

func TestRescanFingerprintsForceAndNestedRoots(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	for _, style := range []string{"absolute", "relative"} {
		t.Run(style, func(t *testing.T) {
			root := t.TempDir()
			absoluteRoot := root
			if style == "relative" {
				cwd, err := os.Getwd()
				if err != nil {
					t.Fatal(err)
				}
				root, err = filepath.Rel(cwd, root)
				if err != nil {
					t.Fatal(err)
				}
			}
			nested := filepath.Join(root, "artist")
			if err := os.MkdirAll(nested, 0700); err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(nested, "fingerprint.flac")
			// A FLAC STREAMINFO block with a two-second stereo stream and a small
			// audio payload exercises the native parsers without requiring ffmpeg.
			data := make([]byte, 4+4+34+32)
			copy(data, "fLaC")
			data[4], data[7] = 0x80, 34
			binary.BigEndian.PutUint64(data[18:26], uint64(44100)<<44|uint64(1)<<41|uint64(15)<<36|88200)
			copy(data[42:], "fingerprint-audio-payload")
			if err := os.WriteFile(file, data, 0600); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				pool.Exec(context.Background(), `DELETE FROM tracks WHERE starts_with(file_path,$1)`, root+string(filepath.Separator))
				pool.Exec(context.Background(), `DELETE FROM albums a WHERE title='Others' AND NOT EXISTS(SELECT 1 FROM tracks t WHERE t.album_id=a.id)`)
			})
			svc := &ingest.Service{
				DB: pool, Library: lib, Storage: storage.NewLocal(root), MusicRoot: root,
				Roots:  func(context.Context) []string { return []string{nested, root, root} },
				Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
			}
			first := svc.IngestFile(ctx, file)
			if first.Err != nil || !first.Inserted {
				t.Fatalf("first ingest = %+v", first)
			}
			absFile, err := filepath.Abs(file)
			if err != nil {
				t.Fatal(err)
			}
			for _, scanRoot := range []string{root, absoluteRoot} {
				fingerprints, err := lib.IngestFingerprints(ctx, []string{scanRoot})
				if err != nil || len(fingerprints) != 1 || fingerprints[absFile].Size != int64(len(data)) {
					t.Fatalf("successful fingerprint root=%q = %+v, %v", scanRoot, fingerprints, err)
				}
			}
			var storedPath, fingerprintPath string
			if err := pool.QueryRow(ctx, `SELECT file_path, ingested_file_path FROM tracks WHERE id=$1`, first.TrackID).
				Scan(&storedPath, &fingerprintPath); err != nil || storedPath != file || fingerprintPath != file {
				t.Fatalf("stored paths = %q/%q, want %q: %v", storedPath, fingerprintPath, file, err)
			}
			scan := func(force bool, wantUnchanged int64) {
				t.Helper()
				p := &ingest.RescanProgress{}
				if err := svc.RescanWithOptions(ctx, p, ingest.RescanOptions{Force: force}); err != nil {
					t.Fatal(err)
				}
				if p.Total.Load() != 1 || p.Processed.Load() != 1 || p.Unchanged.Load() != wantUnchanged || p.Errored.Load() != 0 {
					t.Fatalf("scan force=%v total=%d processed=%d unchanged=%d errors=%d", force, p.Total.Load(), p.Processed.Load(), p.Unchanged.Load(), p.Errored.Load())
				}
			}
			scan(false, 1)
			scan(true, 0)
			changed := time.Now().Add(time.Hour)
			if err := os.Chtimes(file, changed, changed); err != nil {
				t.Fatal(err)
			}
			scan(false, 0)
			scan(false, 1)
			if err := lib.RecordIngestError(ctx, file, "retry despite unchanged metadata"); err != nil {
				t.Fatal(err)
			}
			scan(false, 0)
			scan(false, 1)
			// Moving the canonical row must not associate its old fingerprint with
			// another path, even when a copied file retains its size and mtime.
			if _, err := pool.Exec(ctx, `UPDATE tracks SET file_path=$2 WHERE id=$1`, first.TrackID, filepath.Join(nested, "moved.flac")); err != nil {
				t.Fatal(err)
			}
			got, err := lib.IngestFingerprints(ctx, []string{root})
			if err != nil || !reflect.DeepEqual(got, map[string]library.IngestFingerprint{}) {
				t.Fatalf("moved track reused its old fingerprint: %+v, %v", got, err)
			}
		})
	}
}
