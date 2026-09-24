package tidaldl

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/mediaembed"
	"github.com/githubesson/lumen/internal/playlists"
	"github.com/githubesson/lumen/internal/storage"
	"github.com/githubesson/lumen/internal/tidal"
)

type fakeSource struct {
	tracks map[string]tidal.Track
	errs   map[string]error
}

func (f *fakeSource) Track(_ context.Context, id string) (tidal.Track, error) {
	if err := f.errs[id]; err != nil {
		return tidal.Track{}, err
	}
	return f.tracks[id], nil
}

func (f *fakeSource) FileResponse(context.Context, string, *http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"audio/flac"}},
		Body:       io.NopCloser(strings.NewReader("assembled audio")),
	}, nil
}

func (f *fakeSource) CoverBytes(context.Context, string) ([]byte, error) {
	return nil, errors.New("no covers in tests")
}

// wavTagger stands in for ffmpeg: it consumes the assembled stream and emits
// a WAV of random samples, so each download has distinct audio.
func wavTagger(t *testing.T) tagFunc {
	return func(_ context.Context, r io.ReadCloser, _ []byte, _ mediaembed.Metadata, _ mediaembed.FormatHint) (*mediaembed.Result, error) {
		_, _ = io.Copy(io.Discard, r)
		r.Close()
		samples := make([]byte, 4000)
		_, _ = rand.Read(samples)
		f, err := os.CreateTemp(t.TempDir(), "tagged-*.wav")
		if err != nil {
			return nil, err
		}
		hdr := make([]byte, 44)
		copy(hdr[0:], "RIFF")
		binary.LittleEndian.PutUint32(hdr[4:], uint32(36+len(samples)))
		copy(hdr[8:], "WAVEfmt ")
		binary.LittleEndian.PutUint32(hdr[16:], 16)
		binary.LittleEndian.PutUint16(hdr[20:], 1)    // PCM
		binary.LittleEndian.PutUint16(hdr[22:], 1)    // mono
		binary.LittleEndian.PutUint32(hdr[24:], 8000) // sample rate
		binary.LittleEndian.PutUint32(hdr[28:], 8000) // byte rate
		binary.LittleEndian.PutUint16(hdr[32:], 1)    // block align
		binary.LittleEndian.PutUint16(hdr[34:], 8)    // bits per sample
		copy(hdr[36:], "data")
		binary.LittleEndian.PutUint32(hdr[40:], uint32(len(samples)))
		if _, err := f.Write(append(hdr, samples...)); err != nil {
			return nil, err
		}
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return nil, err
		}
		return &mediaembed.Result{
			File: f, Size: int64(44 + len(samples)), Format: mediaembed.FormatFLAC, Ext: ".wav",
			Cleanup: func() { f.Close(); os.Remove(f.Name()) },
		}, nil
	}
}

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("LUMEN_REVIEW_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set LUMEN_REVIEW_TEST_DATABASE_URL to an isolated PostgreSQL database")
	}
	if err := db.Migrate(url); err != nil {
		t.Fatal(err)
	}
	pool, err := db.Open(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestDrainSavesTIDALTracksAndRepointsPlaylists(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	lib := library.NewStore(pool)
	pls := playlists.NewStore(pool)
	store := NewStore(pool)

	owner, listener := uuid.New(), uuid.New()
	for _, id := range []uuid.UUID{owner, listener} {
		exec(`INSERT INTO users(id, username, password_hash, role) VALUES($1,$2,'test','user')`, id, "tidaldl-"+id.String())
	}
	run := uuid.NewString()[:8]
	matchID, downloadID, brokenID := "m"+run, "d"+run, "b"+run
	isrc := "TEST" + strings.ToUpper(run)

	// A shared library track with the same recording as matchID.
	existing := uuid.New()
	exec(`INSERT INTO tracks(id, title, duration_ms, file_path, file_size, format, audio_sha256, isrc)
	      VALUES($1, 'Already here', 1000, $2, 5, 'flac', $3, $4)`,
		existing, "/nowhere/"+run+".flac", existing[:], strings.ToLower(isrc))
	remote := map[string]uuid.UUID{}
	for _, tid := range []string{matchID, downloadID, brokenID} {
		id, err := lib.UpsertRemoteTrack(ctx, library.RemoteTrackInput{
			Source: "tidal", ExternalID: tid, Title: "Remote " + tid, ArtistNames: []string{"Remote"}, DurationMS: 1000,
		})
		if err != nil {
			t.Fatal(err)
		}
		remote[tid] = id
	}

	auto, err := pls.Create(ctx, owner, "auto", "", playlists.VisibilityPrivate)
	if err != nil {
		t.Fatal(err)
	}
	manual, err := pls.Create(ctx, owner, "manual", "", playlists.VisibilityPrivate)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		c := context.Background()
		pool.Exec(c, `DELETE FROM playlists WHERE id = ANY($1)`, []uuid.UUID{auto.ID, manual.ID})
		pool.Exec(c, `DELETE FROM tidal_downloads WHERE tidal_id = ANY($1)`, []string{matchID, downloadID, brokenID})
		pool.Exec(c, `DELETE FROM tracks WHERE id = $1 OR external_id = ANY($2) OR file_path LIKE $3`,
			existing, []string{matchID, downloadID, brokenID}, "%"+run+"%")
		pool.Exec(c, `DELETE FROM users WHERE id = ANY($1)`, []uuid.UUID{owner, listener})
	})
	if err := pls.AddTracks(ctx, auto.ID, []uuid.UUID{remote[matchID], remote[downloadID], remote[brokenID]}, owner); err != nil {
		t.Fatal(err)
	}
	// Only the manual playlist holds downloadID twice; the swap is global.
	if err := pls.AddTracks(ctx, manual.ID, []uuid.UUID{remote[downloadID], remote[downloadID]}, owner); err != nil {
		t.Fatal(err)
	}

	// The listener has history on both the remote row and the local copy.
	exec(`INSERT INTO user_track_stats(user_id, track_id, play_count, last_played_at, favorited, favorited_at)
	      VALUES($1, $2, 2, NOW() - INTERVAL '1 day', TRUE, NOW() - INTERVAL '2 days')`, listener, remote[matchID])
	exec(`INSERT INTO user_track_stats(user_id, track_id, play_count, last_played_at) VALUES($1, $2, 3, NOW())`, listener, existing)
	exec(`INSERT INTO play_history(user_id, track_id) VALUES($1, $2), ($1, $2)`, listener, remote[matchID])

	// Nothing is queued until the playlist opts in.
	if pending, err := store.Pending(ctx, 100); err != nil {
		t.Fatal(err)
	} else if containsRow(pending, remote[matchID]) {
		t.Fatal("queued a track from a playlist without auto-download")
	}
	if err := pls.SetTIDALAutoDownload(ctx, auto.ID, true); err != nil {
		t.Fatal(err)
	}
	if got, err := pls.Get(ctx, auto.ID); err != nil || !got.TIDALAutoDownload {
		t.Fatalf("flag not persisted: %+v, %v", got, err)
	}
	if err := pls.SetTIDALAutoDownload(ctx, uuid.New(), true); !errors.Is(err, playlists.ErrNotFound) {
		t.Fatalf("missing playlist: %v", err)
	}

	// The subdir comes from the shared settings row, which the API
	// integration test (another package, possibly running concurrently)
	// rewrites; assertions below only pin the root and the layout.
	root := t.TempDir()
	w := &Worker{
		Store:   store,
		Library: lib,
		Ingest: &ingest.Service{
			DB: pool, Library: lib, Storage: storage.NewLocal(root), MusicRoot: root,
			Roots: func(context.Context) []string { return []string{root} },
		},
		PrimaryRoot: root,
		source: &fakeSource{
			tracks: map[string]tidal.Track{
				matchID: {ID: matchID, Title: "Match", Artists: []string{"Remote"}, ISRC: isrc},
				downloadID: {
					ID: downloadID, Title: "Fresh " + run, TrackNo: 7, AlbumTitle: "Record",
					AlbumArtist: "Simon & Garfunkel", Artists: []string{"Simon & Garfunkel", "Guest"},
				},
			},
			errs: map[string]error{brokenID: errors.New("upstream 500")},
		},
		tag: wavTagger(t),
	}
	w.drain(ctx)

	// ISRC match: no download, references moved, stats merged.
	if got, err := lib.DownloadedTIDALTrack(ctx, matchID); err != nil || got != existing {
		t.Fatalf("match resolved to %v, %v; want %v", got, err, existing)
	}
	var plays int
	var fav bool
	if err := pool.QueryRow(ctx, `SELECT play_count, favorited FROM user_track_stats WHERE user_id = $1 AND track_id = $2`,
		listener, existing).Scan(&plays, &fav); err != nil {
		t.Fatal(err)
	}
	if plays != 5 || !fav {
		t.Fatalf("merged stats = %d plays, favorited %v; want 5, true", plays, fav)
	}
	var leftovers int
	if err := pool.QueryRow(ctx, `
		SELECT (SELECT COUNT(*) FROM user_track_stats WHERE track_id = $1)
		     + (SELECT COUNT(*) FROM play_history WHERE track_id = $1)
		     + (SELECT COUNT(*) FROM playlist_tracks WHERE track_id = $1)`, remote[matchID]).Scan(&leftovers); err != nil {
		t.Fatal(err)
	}
	if leftovers != 0 {
		t.Fatalf("%d references still point at the remote row", leftovers)
	}

	// Download: written under the destination, ingested, playlists repointed.
	saved, err := lib.DownloadedTIDALTrack(ctx, downloadID)
	if err != nil {
		t.Fatal(err)
	}
	var path string
	if err := pool.QueryRow(ctx, `SELECT file_path FROM tracks WHERE id = $1`, saved).Scan(&path); err != nil {
		t.Fatal(err)
	}
	layout := filepath.Join("Simon & Garfunkel", "Record", "07 - Fresh "+run+".wav")
	if !strings.HasPrefix(path, root+string(filepath.Separator)) || !strings.HasSuffix(path, layout) {
		t.Fatalf("saved to %q, want %s/…/%s", path, root, layout)
	}
	var artists string
	if err := pool.QueryRow(ctx, `
		SELECT STRING_AGG(ar.name, '|' ORDER BY ta.position)
		FROM track_artists ta JOIN artists ar ON ar.id = ta.artist_id
		WHERE ta.track_id = $1`, saved).Scan(&artists); err != nil {
		t.Fatal(err)
	}
	if artists != "Simon & Garfunkel|Guest" {
		t.Fatalf("artists = %q", artists)
	}
	var inManual int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = $1 AND track_id = $2`,
		manual.ID, saved).Scan(&inManual); err != nil {
		t.Fatal(err)
	}
	if inManual != 2 {
		t.Fatalf("manual playlist has %d local entries, want 2", inManual)
	}

	// Failure: recorded, backed off, and retried on demand.
	recent, err := store.Recent(ctx, 200)
	if err != nil {
		t.Fatal(err)
	}
	broken := findDownload(recent, brokenID)
	if broken == nil || broken.Status != StatusFailed || broken.Attempts != 1 ||
		!strings.Contains(broken.Error, "upstream 500") || broken.NextAttemptAt == nil ||
		broken.NextAttemptAt.Before(time.Now().Add(4*time.Minute)) {
		t.Fatalf("failure record = %+v", broken)
	}
	if pending, err := store.Pending(ctx, 100); err != nil || len(pending) != 0 {
		t.Fatalf("pending during backoff = %v, %v", pending, err)
	}
	summary, err := store.Summary(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if summary.Failed < 1 || summary.Saved < 2 || summary.Playlists < 1 {
		t.Fatalf("summary = %+v", summary)
	}
	if _, err := store.RetryFailed(ctx); err != nil {
		t.Fatal(err)
	}
	if pending, err := store.Pending(ctx, 100); err != nil || !containsRow(pending, remote[brokenID]) {
		t.Fatalf("pending after retry = %v, %v", pending, err)
	}
	w.drain(ctx)
	recent, _ = store.Recent(ctx, 200)
	if broken = findDownload(recent, brokenID); broken == nil || broken.Attempts != 2 ||
		broken.NextAttemptAt.Before(time.Now().Add(9*time.Minute)) {
		t.Fatalf("second failure did not back off further: %+v", broken)
	}

	// Once saved, a `tidal:` reference resolves to the local copy.
	if got, err := lib.DownloadedTIDALTrack(ctx, brokenID); !errors.Is(err, library.ErrNotFound) {
		t.Fatalf("failed track resolved to %v, %v", got, err)
	}
}

func containsRow(cs []Candidate, id uuid.UUID) bool {
	for _, c := range cs {
		if c.RowID == id {
			return true
		}
	}
	return false
}

func findDownload(ds []Download, tidalID string) *Download {
	for i := range ds {
		if ds[i].TIDALID == tidalID {
			return &ds[i]
		}
	}
	return nil
}

func TestDownloadNeverAdoptsAFileAlreadyAtTheTarget(t *testing.T) {
	dest := t.TempDir()
	meta := tidal.Track{ID: "1", Title: "Song", TrackNo: 1, AlbumTitle: "Album", AlbumArtist: "Band"}
	occupied := filepath.Join(dest, TrackPath(meta)+".wav")
	if err := os.MkdirAll(filepath.Dir(occupied), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(occupied, []byte("another release"), 0o644); err != nil {
		t.Fatal(err)
	}
	w := &Worker{source: &fakeSource{}, tag: wavTagger(t)}
	got, err := w.download(context.Background(), meta, dest)
	if err != nil {
		t.Fatal(err)
	}
	if got == occupied {
		t.Fatal("download reused the existing file")
	}
	if b, _ := os.ReadFile(occupied); string(b) != "another release" {
		t.Fatalf("existing file was modified: %q", b)
	}
}

func TestDrainLinksISRCMatchesWithoutFFmpeg(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	lib := library.NewStore(pool)
	pls := playlists.NewStore(pool)
	store := NewStore(pool)

	owner := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id, username, password_hash, role) VALUES($1,$2,'test','user')`,
		owner, "tidaldl-"+owner.String()); err != nil {
		t.Fatal(err)
	}
	run := uuid.NewString()[:8]
	matchID, downloadID := "fm"+run, "fd"+run
	isrc := "FF" + strings.ToUpper(run)
	existing := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO tracks(id, title, duration_ms, file_path, file_size, format, audio_sha256, isrc)
		VALUES($1, 'Already here', 1000, $2, 5, 'flac', $3, $4)`,
		existing, "/nowhere/"+run+".flac", existing[:], isrc); err != nil {
		t.Fatal(err)
	}
	var rows []uuid.UUID
	for _, tid := range []string{downloadID, matchID} {
		id, err := lib.UpsertRemoteTrack(ctx, library.RemoteTrackInput{
			Source: "tidal", ExternalID: tid, Title: "Remote " + tid, ArtistNames: []string{"Remote"}, DurationMS: 1000,
		})
		if err != nil {
			t.Fatal(err)
		}
		rows = append(rows, id)
	}
	pl, err := pls.Create(ctx, owner, "auto", "", playlists.VisibilityPrivate)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		c := context.Background()
		pool.Exec(c, `DELETE FROM playlists WHERE id = $1`, pl.ID)
		pool.Exec(c, `DELETE FROM tidal_downloads WHERE tidal_id = ANY($1)`, []string{matchID, downloadID})
		pool.Exec(c, `DELETE FROM tracks WHERE id = $1 OR external_id = ANY($2)`, existing, []string{matchID, downloadID})
		pool.Exec(c, `DELETE FROM users WHERE id = $1`, owner)
	})
	// The track that needs a download comes first, so a drain that gave up at
	// the first ffmpeg failure would never reach the match.
	if err := pls.AddTracks(ctx, pl.ID, rows, owner); err != nil {
		t.Fatal(err)
	}
	if err := pls.SetTIDALAutoDownload(ctx, pl.ID, true); err != nil {
		t.Fatal(err)
	}

	w := &Worker{
		Store: store, Library: lib, PrimaryRoot: t.TempDir(),
		source: &fakeSource{tracks: map[string]tidal.Track{
			matchID:    {ID: matchID, Title: "Match", ISRC: isrc},
			downloadID: {ID: downloadID, Title: "Needs download"},
		}},
		ffmpeg: func() bool { return false },
	}
	w.drain(ctx)

	if got, err := lib.DownloadedTIDALTrack(ctx, matchID); err != nil || got != existing {
		t.Fatalf("ISRC match resolved to %v, %v; want %v", got, err, existing)
	}
	recent, err := store.Recent(ctx, 200)
	if err != nil {
		t.Fatal(err)
	}
	if d := findDownload(recent, downloadID); d == nil || d.Status != StatusFailed || !strings.Contains(d.Error, "ffmpeg") {
		t.Fatalf("download without ffmpeg = %+v", d)
	}
}
