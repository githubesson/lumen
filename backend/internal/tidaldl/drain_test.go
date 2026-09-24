package tidaldl

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/downloadfile"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/mediaembed"
	"github.com/githubesson/lumen/internal/musicroots"
	"github.com/githubesson/lumen/internal/playlists"
	"github.com/githubesson/lumen/internal/storage"
	"github.com/githubesson/lumen/internal/tidal"
)

type fakeSource struct {
	tracks  map[string]tidal.Track
	errs    map[string]error
	onTrack func(id string)
	body    func() io.Reader // default: a short fixed body
}

func (f *fakeSource) Track(_ context.Context, id string) (tidal.Track, error) {
	if f.onTrack != nil {
		f.onTrack(id)
	}
	if err := f.errs[id]; err != nil {
		return tidal.Track{}, err
	}
	return f.tracks[id], nil
}

func (f *fakeSource) FileResponse(context.Context, string, *http.Request) (*http.Response, error) {
	var body io.Reader = strings.NewReader("assembled audio")
	if f.body != nil {
		body = f.body()
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"audio/flac"}},
		Body:       io.NopCloser(body),
	}, nil
}

func (f *fakeSource) CoverBytes(context.Context, string) ([]byte, error) {
	return nil, errors.New("no covers in tests")
}

// wavTagger stands in for ffmpeg: it consumes the assembled stream and emits
// a WAV of random samples, so each download has distinct audio.
func wavTagger(t *testing.T) tagFunc { return wavTaggerWith(t, nil) }

// wavTaggerWith emits fixed samples for the titles in fixed, random otherwise.
func wavTaggerWith(t *testing.T, fixed map[string][]byte) tagFunc {
	return func(_ context.Context, r io.ReadCloser, _ []byte, meta mediaembed.Metadata, _ mediaembed.FormatHint) (*mediaembed.Result, error) {
		_, _ = io.Copy(io.Discard, r)
		r.Close()
		samples, ok := fixed[meta.Title]
		if !ok {
			samples = make([]byte, 4000)
			_, _ = rand.Read(samples)
		}
		f, err := writeWAV(t, samples)
		if err != nil {
			return nil, err
		}
		return &mediaembed.Result{
			File: f, Size: int64(44 + len(samples)), Format: mediaembed.FormatFLAC, Ext: ".wav",
			Cleanup: func() { f.Close(); os.Remove(f.Name()) },
		}, nil
	}
}

// writeWAV writes a mono 8-bit PCM WAV and returns it rewound.
func writeWAV(t *testing.T, samples []byte) (*os.File, error) {
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
	return f, nil
}

// audioSHA is the ingest hash of a WAV holding samples.
func audioSHA(t *testing.T, samples []byte) []byte {
	t.Helper()
	f, err := writeWAV(t, samples)
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	h, err := ingest.AudioSHA256(context.Background(), f.Name())
	if err != nil {
		t.Fatal(err)
	}
	b, err := hex.DecodeString(h)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// libraryFile writes a playable stand-in for an existing library track in its
// own music root, so ISRC matches pass the worker's playability check.
func libraryFile(t *testing.T) (root, path string) {
	t.Helper()
	root = t.TempDir()
	path = filepath.Join(root, "existing.flac")
	if err := os.WriteFile(path, []byte("existing audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root, path
}

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	base := os.Getenv("LUMEN_REVIEW_TEST_DATABASE_URL")
	if base == "" {
		t.Skip("set LUMEN_REVIEW_TEST_DATABASE_URL to an isolated PostgreSQL database")
	}
	dsn := ownDatabase(t, base)
	if err := db.Migrate(dsn); err != nil {
		t.Fatal(err)
	}
	pool, err := db.Open(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// ownDatabase returns a sibling database for this package's tests. `go test
// ./...` runs packages in parallel, and these tests add shared library tracks
// that other packages' tests (which count visible tracks) would see.
func ownDatabase(t *testing.T, base string) string {
	t.Helper()
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	name := strings.TrimPrefix(u.Path, "/") + "_tidaldl"
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize())
	var pgErr *pgconn.PgError
	if err != nil && !(errors.As(err, &pgErr) && pgErr.Code == "42P04") { // duplicate_database
		t.Logf("using the shared test database; could not create %s: %v", name, err)
		return base
	}
	u.Path = "/" + name
	return u.String()
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
	libRoot, libPath := libraryFile(t)
	exec(`INSERT INTO tracks(id, title, duration_ms, file_path, file_size, format, audio_sha256, isrc)
	      VALUES($1, 'Already here', 1000, $2, 5, 'flac', $3, $4)`,
		existing, libPath, existing[:], strings.ToLower(isrc))
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
			Roots: func(context.Context) []string { return []string{root, libRoot} },
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

// Linking needs neither ffmpeg, a destination, nor a successful ingest, so a
// problem with any of them must only fail the tracks that need a download.
func TestDrainLinksISRCMatchesWhenDownloadsCannotRun(t *testing.T) {
	pool := testPool(t)
	for _, tc := range []struct {
		name    string
		setup   func(w *Worker, root string)
		wantErr string
	}{
		{"ffmpeg missing", func(w *Worker, _ string) {
			w.tag = nil // the real tagger path, which checks for ffmpeg
			w.ffmpeg = func() bool { return false }
		}, "ffmpeg"},
		{"no destination", func(w *Worker, _ string) { w.PrimaryRoot = "" }, "no music root"},
		{"volume nearly full", func(w *Worker, _ string) {
			w.MinFreeBytes = 5 << 30
			w.free = func(string) (uint64, bool) { return 1 << 30, true }
		}, "not enough free space"},
		{"ingest rejects the file", func(w *Worker, _ string) {
			tagWAV := wavTagger(t)
			w.tag = func(ctx context.Context, r io.ReadCloser, c []byte, m mediaembed.Metadata, h mediaembed.FormatHint) (*mediaembed.Result, error) {
				res, err := tagWAV(ctx, r, c, m, h)
				if res != nil {
					res.Ext = ".unsupported"
				}
				return res, err
			}
		}, "ingest skipped"},
	} {
		t.Run(tc.name, func(t *testing.T) {
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
			libRoot, libPath := libraryFile(t)
			if _, err := pool.Exec(ctx, `INSERT INTO tracks(id, title, duration_ms, file_path, file_size, format, audio_sha256, isrc)
				VALUES($1, 'Already here', 1000, $2, 5, 'flac', $3, $4)`,
				existing, libPath, existing[:], isrc); err != nil {
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
			// The track that needs a download comes first, so a drain that gave
			// up at its failure would never reach the match.
			if err := pls.AddTracks(ctx, pl.ID, rows, owner); err != nil {
				t.Fatal(err)
			}
			if err := pls.SetTIDALAutoDownload(ctx, pl.ID, true); err != nil {
				t.Fatal(err)
			}

			root := t.TempDir()
			w := &Worker{
				Store: store, Library: lib, PrimaryRoot: root,
				Ingest: &ingest.Service{
					DB: pool, Library: lib, Storage: storage.NewLocal(root), MusicRoot: root,
					Roots: func(context.Context) []string { return []string{root, libRoot} },
				},
				source: &fakeSource{tracks: map[string]tidal.Track{
					matchID:    {ID: matchID, Title: "Match", ISRC: isrc},
					downloadID: {ID: downloadID, Title: "Needs download", AlbumArtist: "Band"},
				}},
				tag: wavTagger(t),
			}
			tc.setup(w, root)
			w.drain(ctx)

			if got, err := lib.DownloadedTIDALTrack(ctx, matchID); err != nil || got != existing {
				t.Fatalf("ISRC match resolved to %v, %v; want %v", got, err, existing)
			}
			recent, err := store.Recent(ctx, 200)
			if err != nil {
				t.Fatal(err)
			}
			if d := findDownload(recent, downloadID); d == nil || d.Status != StatusFailed || !strings.Contains(d.Error, tc.wantErr) {
				t.Fatalf("failed download = %+v, want error containing %q", d, tc.wantErr)
			}
			var leftovers []string
			_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
				if err == nil && !d.IsDir() {
					leftovers = append(leftovers, p)
				}
				return nil
			})
			if len(leftovers) > 0 {
				t.Fatalf("failed download left files behind: %v", leftovers)
			}
		})
	}
}

func TestDestinationRejectsDisabledRoot(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	roots := musicroots.NewStore(pool)
	root, err := roots.Add(ctx, t.TempDir(), "extra")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { roots.Delete(context.Background(), root.ID) })
	w := &Worker{Roots: roots, PrimaryRoot: t.TempDir()}
	settings := Settings{RootID: &root.ID, Subdir: "TIDAL"}
	if got, err := w.destinationFor(ctx, settings); err != nil || got != filepath.Join(root.Path, "TIDAL") {
		t.Fatalf("enabled root: %q, %v", got, err)
	}
	if _, err := roots.SetEnabled(ctx, root.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := w.destinationFor(ctx, settings); err == nil || !strings.Contains(err.Error(), "disabled") {
		t.Fatalf("disabled root accepted: %v", err)
	}
}

// Adopting replaces a working TIDAL entry, so a local copy is only reused if
// the stream endpoint would actually serve it.
func TestDrainSkipsUnplayableLocalCopies(t *testing.T) {
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
	root := t.TempDir()    // the only music root
	outside := t.TempDir() // exists, but not a music root
	libRoot, playablePath := libraryFile(t)
	outsidePath := filepath.Join(outside, "outside.flac")
	if err := os.WriteFile(outsidePath, []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}

	run := uuid.NewString()[:8]
	mixedID, missingID, staleID := "um"+run, "ux"+run, "us"+run
	deadTwinID, liveTwinID := "ud"+run, "ul"+run
	mixedISRC, missingISRC := "UM"+strings.ToUpper(run), "UX"+strings.ToUpper(run)
	localWithSHA := func(path, isrc string, age int, sha []byte) uuid.UUID {
		t.Helper()
		id := uuid.New()
		if sha == nil {
			sha = id[:]
		}
		if _, err := pool.Exec(ctx, `INSERT INTO tracks(id, title, duration_ms, file_path, file_size, format, audio_sha256, isrc, created_at)
			VALUES($1, 'Local', 1000, $2, 5, 'flac', $3, NULLIF($4, ''), NOW() - make_interval(mins => $5))`,
			id, path, sha, isrc, age); err != nil {
			t.Fatal(err)
		}
		return id
	}
	local := func(path, isrc string, age int) uuid.UUID { return localWithSHA(path, isrc, age, nil) }
	// Oldest first: a missing file, then a file outside every root, then a
	// playable copy — only the last may be adopted.
	missingFile := local(filepath.Join(root, "gone-"+run+".flac"), mixedISRC, 30)
	outsideRoot := local(outsidePath, mixedISRC, 20)
	playable := local(playablePath, mixedISRC, 10)
	onlyMissing := local(filepath.Join(root, "gone2-"+run+".flac"), missingISRC, 5)
	staleCopy := local(filepath.Join(root, "gone3-"+run+".flac"), "", 5)
	// Rows with the same audio as the next downloads. Ingest would fold the
	// download into them (deleting it when their file exists), so the dead
	// twin must be moved onto the new copy, and the live one reused as is.
	deadAudio, liveAudio := []byte("dead twin "+run), []byte("live twin "+run)
	deadTwin := localWithSHA(outsidePath, "", 5, audioSHA(t, deadAudio))
	liveTwinPath := filepath.Join(libRoot, "twin-"+run+".flac")
	if err := os.WriteFile(liveTwinPath, []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	liveTwin := localWithSHA(liveTwinPath, "", 5, audioSHA(t, liveAudio))
	if _, err := pool.Exec(ctx, `INSERT INTO tidal_downloads(tidal_id, status, local_track_id) VALUES($1, 'downloaded', $2)`,
		staleID, staleCopy); err != nil {
		t.Fatal(err)
	}

	var rows []uuid.UUID
	for _, tid := range []string{mixedID, missingID, staleID, deadTwinID, liveTwinID} {
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
	locals := []uuid.UUID{missingFile, outsideRoot, playable, onlyMissing, staleCopy, deadTwin, liveTwin}
	t.Cleanup(func() {
		c := context.Background()
		pool.Exec(c, `DELETE FROM playlists WHERE id = $1`, pl.ID)
		tids := []string{mixedID, missingID, staleID, deadTwinID, liveTwinID}
		pool.Exec(c, `DELETE FROM tidal_downloads WHERE tidal_id = ANY($1)`, tids)
		pool.Exec(c, `DELETE FROM tracks WHERE id = ANY($1) OR external_id = ANY($2) OR file_path LIKE $3`,
			locals, tids, root+"%")
		pool.Exec(c, `DELETE FROM users WHERE id = $1`, owner)
	})
	if err := pls.AddTracks(ctx, pl.ID, rows, owner); err != nil {
		t.Fatal(err)
	}
	if err := pls.SetTIDALAutoDownload(ctx, pl.ID, true); err != nil {
		t.Fatal(err)
	}

	w := &Worker{
		Store: store, Library: lib, PrimaryRoot: root,
		Ingest: &ingest.Service{
			DB: pool, Library: lib, Storage: storage.NewLocal(root), MusicRoot: root,
			Roots: func(context.Context) []string { return []string{root, libRoot} },
		},
		source: &fakeSource{tracks: map[string]tidal.Track{
			mixedID:    {ID: mixedID, Title: "Mixed " + run, ISRC: mixedISRC},
			missingID:  {ID: missingID, Title: "Missing " + run, ISRC: missingISRC},
			staleID:    {ID: staleID, Title: "Stale " + run},
			deadTwinID: {ID: deadTwinID, Title: "Dead twin " + run},
			liveTwinID: {ID: liveTwinID, Title: "Live twin " + run},
		}},
		tag: wavTaggerWith(t, map[string][]byte{"Dead twin " + run: deadAudio, "Live twin " + run: liveAudio}),
	}
	w.drain(ctx)

	if got, err := lib.DownloadedTIDALTrack(ctx, mixedID); err != nil || got != playable {
		t.Fatalf("mixed matches adopted %v, %v; want the playable %v", got, err, playable)
	}
	for tid, dead := range map[string]uuid.UUID{missingID: onlyMissing, staleID: staleCopy} {
		got, err := lib.DownloadedTIDALTrack(ctx, tid)
		if err != nil || got == dead {
			t.Fatalf("%s resolved to %v, %v; want a fresh download instead of %v", tid, got, err, dead)
		}
		path, err := store.TrackFilePath(ctx, got)
		if err != nil || !w.playable(ctx, path) {
			t.Fatalf("%s saved to unplayable %q, %v", tid, path, err)
		}
	}

	// The dead twin keeps its row (and history) but now plays the new copy.
	if got, err := lib.DownloadedTIDALTrack(ctx, deadTwinID); err != nil || got != deadTwin {
		t.Fatalf("dead twin resolved to %v, %v; want %v", got, err, deadTwin)
	}
	if path, err := store.TrackFilePath(ctx, deadTwin); err != nil || !w.playable(ctx, path) || !strings.HasPrefix(path, root) {
		t.Fatalf("dead twin was not moved onto the new copy: %q, %v", path, err)
	}
	if _, err := os.Stat(outsidePath); err != nil {
		t.Fatalf("the old file outside the roots should be left alone: %v", err)
	}
	// The live twin is reused, and the duplicate download discarded.
	if got, err := lib.DownloadedTIDALTrack(ctx, liveTwinID); err != nil || got != liveTwin {
		t.Fatalf("live twin resolved to %v, %v; want %v", got, err, liveTwin)
	}
	if path, _ := store.TrackFilePath(ctx, liveTwin); path != liveTwinPath {
		t.Fatalf("live twin moved to %q", path)
	}
	var stray []string
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.Contains(p, "Live twin") {
			stray = append(stray, p)
		}
		return nil
	})
	if len(stray) > 0 {
		t.Fatalf("duplicate download left behind: %v", stray)
	}
}

// optedInPlaylist creates a user and an opted-in playlist holding a remote
// row per TIDAL id, in order, cleaned up with the test.
func optedInPlaylist(t *testing.T, pool *pgxpool.Pool, tids ...string) (uuid.UUID, []uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	lib := library.NewStore(pool)
	pls := playlists.NewStore(pool)
	owner := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id, username, password_hash, role) VALUES($1,$2,'test','user')`,
		owner, "tidaldl-"+owner.String()); err != nil {
		t.Fatal(err)
	}
	var rows []uuid.UUID
	for _, tid := range tids {
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
		pool.Exec(c, `DELETE FROM tidal_downloads WHERE tidal_id = ANY($1)`, tids)
		pool.Exec(c, `DELETE FROM tracks WHERE external_id = ANY($1)`, tids)
		pool.Exec(c, `DELETE FROM users WHERE id = $1`, owner)
	})
	if err := pls.AddTracks(ctx, pl.ID, rows, owner); err != nil {
		t.Fatal(err)
	}
	if err := pls.SetTIDALAutoDownload(ctx, pl.ID, true); err != nil {
		t.Fatal(err)
	}
	return pl.ID, rows
}

func testWorker(t *testing.T, pool *pgxpool.Pool, root string, src *fakeSource) *Worker {
	lib := library.NewStore(pool)
	return &Worker{
		Store: NewStore(pool), Library: lib, PrimaryRoot: root,
		Ingest: &ingest.Service{
			DB: pool, Library: lib, Storage: storage.NewLocal(root), MusicRoot: root,
			Roots: func(context.Context) []string { return []string{root} },
		},
		source: src,
		tag:    wavTagger(t),
	}
}

func TestDrainStopsWhenPlaylistOptsOutMidBatch(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	run := uuid.NewString()[:8]
	first, second := "sa"+run, "sb"+run
	pl, _ := optedInPlaylist(t, pool, first, second)
	root := t.TempDir()
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM tracks WHERE file_path LIKE $1`, root+"%") })
	src := &fakeSource{tracks: map[string]tidal.Track{
		first:  {ID: first, Title: "First " + run},
		second: {ID: second, Title: "Second " + run},
	}}
	// The admin turns auto-download off while the batch's first track (either
	// one: they share added_at) is processing.
	var once sync.Once
	src.onTrack = func(string) {
		once.Do(func() {
			if err := playlists.NewStore(pool).SetTIDALAutoDownload(ctx, pl, false); err != nil {
				t.Error(err)
			}
		})
	}
	w := testWorker(t, pool, root, src)
	w.drain(ctx)

	recent, err := w.Store.Recent(ctx, 200)
	if err != nil {
		t.Fatal(err)
	}
	a, b := findDownload(recent, first), findDownload(recent, second)
	if (a == nil) == (b == nil) {
		t.Fatalf("want exactly one track processed after opting out; got %+v and %+v", a, b)
	}
}

// The filesystem watcher can ingest the new file before the worker's audio
// twin check or between that check and the worker's own ingest. Either way
// the row is the worker's and needs TIDAL's artist list.
func TestWatcherWinningIngestStillGetsTIDALArtists(t *testing.T) {
	pool := testPool(t)
	for _, tc := range []struct {
		name string
		hook func(w *Worker, ingest func(string))
	}{
		{"before the twin check", func(w *Worker, ingest func(string)) { w.saved = ingest }},
		{"before the worker's ingest", func(w *Worker, ingest func(string)) { w.beforeIngest = ingest }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			run := uuid.NewString()[:8]
			tid := "wr" + run
			optedInPlaylist(t, pool, tid)
			root := t.TempDir()
			t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM tracks WHERE file_path LIKE $1`, root+"%") })
			w := testWorker(t, pool, root, &fakeSource{tracks: map[string]tidal.Track{
				tid: {ID: tid, Title: "Duet " + run, Artists: []string{"Simon & Garfunkel", "Guest"}},
			}})
			tc.hook(w, func(path string) { w.Ingest.IngestFile(ctx, path) })
			w.drain(ctx)

			saved, err := w.Library.DownloadedTIDALTrack(ctx, tid)
			if err != nil {
				t.Fatal(err)
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
			recent, _ := w.Store.Recent(ctx, 200)
			if d := findDownload(recent, tid); d == nil || d.Status != StatusDownloaded {
				t.Fatalf("status = %+v, want downloaded", d)
			}
		})
	}
}

// A saved copy that is deleted — hard (file gone, admin delete) or soft (root
// purge) — must hand its playlist entries back to the TIDAL row, not drop
// or hide them.
func TestDeletedSavedCopyFallsBackToTIDAL(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	run := uuid.NewString()[:8]
	tid := "fb" + run
	pl, rows := optedInPlaylist(t, pool, tid)
	remote := rows[0]
	root := t.TempDir()
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM tracks WHERE file_path LIKE $1`, root+"%") })
	w := testWorker(t, pool, root, &fakeSource{tracks: map[string]tidal.Track{tid: {ID: tid, Title: "Fallback " + run}}})

	entry := func() uuid.UUID {
		t.Helper()
		var id uuid.UUID
		if err := pool.QueryRow(ctx, `SELECT track_id FROM playlist_tracks WHERE playlist_id = $1`, pl).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	// A listener's history on the TIDAL track must survive every round trip.
	var owner uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT owner_id FROM playlists WHERE id = $1`, pl).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO user_track_stats(user_id, track_id, play_count, favorited) VALUES($1, $2, 3, TRUE)`,
		owner, remote); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO play_history(user_id, track_id) VALUES($1, $2)`, owner, remote); err != nil {
		t.Fatal(err)
	}
	history := func(track uuid.UUID) (plays int, fav bool, rows int) {
		t.Helper()
		_ = pool.QueryRow(ctx, `SELECT play_count, favorited FROM user_track_stats WHERE user_id = $1 AND track_id = $2`,
			owner, track).Scan(&plays, &fav)
		if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM play_history WHERE user_id = $1 AND track_id = $2`,
			owner, track).Scan(&rows); err != nil {
			t.Fatal(err)
		}
		return plays, fav, rows
	}
	for _, del := range []struct {
		name string
		run  func(local uuid.UUID, path string) error
	}{
		{"file gone from disk", func(_ uuid.UUID, path string) error { return w.Library.HardDeleteByPath(ctx, path) }},
		{"root purged", func(local uuid.UUID, _ string) error {
			_, err := pool.Exec(ctx, `UPDATE tracks SET deleted_at = NOW() WHERE id = $1`, local)
			return err
		}},
	} {
		w.drain(ctx)
		local, err := w.Library.DownloadedTIDALTrack(ctx, tid)
		if err != nil {
			t.Fatalf("%s: not saved: %v", del.name, err)
		}
		if got := entry(); got != local {
			t.Fatalf("%s: entry %v before delete, want the saved copy %v", del.name, got, local)
		}
		if plays, fav, rows := history(local); plays != 3 || !fav || rows != 1 {
			t.Fatalf("%s: history on the saved copy = %d plays, fav %v, %d rows", del.name, plays, fav, rows)
		}
		if got, err := w.Library.RedirectSavedTIDAL(ctx, remote); err != nil || got != local {
			t.Fatalf("%s: stale remote id redirected to %v, %v; want %v", del.name, got, err, local)
		}
		path, err := w.Store.TrackFilePath(ctx, local)
		if err != nil {
			t.Fatal(err)
		}
		if err := del.run(local, path); err != nil {
			t.Fatal(err)
		}
		if got := entry(); got != remote {
			t.Fatalf("%s: entry %v after delete, want the TIDAL row %v", del.name, got, remote)
		}
		if plays, fav, rows := history(remote); plays != 3 || !fav || rows != 1 {
			t.Fatalf("%s: history back on TIDAL = %d plays, fav %v, %d rows", del.name, plays, fav, rows)
		}
		if got, err := w.Library.RedirectSavedTIDAL(ctx, remote); err != nil || got != remote {
			t.Fatalf("%s: remote id redirected to %v, %v after delete", del.name, got, err)
		}
		if pending, err := w.Store.Pending(ctx, 100); err != nil || !containsRow(pending, remote) {
			t.Fatalf("%s: not queued again: %v, %v", del.name, pending, err)
		}
	}
}

// Several TIDAL ids can share one library copy (single and album releases of
// one recording share an ISRC). Deleting it must return each entry to its own
// TIDAL track, even after a reorder, and leave entries that were always the
// library track to the usual deletion rules.
func TestFallbackReturnsEachEntryToItsOwnTIDALTrack(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	run := uuid.NewString()[:8]
	single, album := "fs"+run, "fa"+run
	isrc := "FS" + strings.ToUpper(run)
	pl, rows := optedInPlaylist(t, pool, single, album)
	var owner uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT owner_id FROM playlists WHERE id = $1`, pl).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	libRoot, libPath := libraryFile(t)
	shared := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO tracks(id, title, duration_ms, file_path, file_size, format, audio_sha256, isrc)
		VALUES($1, 'Shared', 1000, $2, 5, 'flac', $3, $4)`, shared, libPath, shared[:], isrc); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM tracks WHERE id = $1`, shared) })
	pls := playlists.NewStore(pool)
	// The playlist also holds the library track itself.
	if err := pls.AddTracks(ctx, pl, []uuid.UUID{shared}, owner); err != nil {
		t.Fatal(err)
	}

	w := testWorker(t, pool, t.TempDir(), &fakeSource{tracks: map[string]tidal.Track{
		single: {ID: single, Title: "Song", ISRC: isrc},
		album:  {ID: album, Title: "Song", ISRC: isrc},
	}})
	w.Ingest.Roots = func(context.Context) []string { return []string{libRoot} }
	w.drain(ctx)
	for _, tid := range []string{single, album} {
		if got, err := w.Library.DownloadedTIDALTrack(ctx, tid); err != nil || got != shared {
			t.Fatalf("%s resolved to %v, %v; want the shared copy", tid, got, err)
		}
	}
	// Reordering rewrites every row; provenance has to survive it.
	if err := pls.ReplaceOrder(ctx, pl, owner, []uuid.UUID{shared, shared, shared}); err != nil {
		t.Fatal(err)
	}
	if err := w.Library.HardDeleteByPath(ctx, libPath); err != nil {
		t.Fatal(err)
	}

	got := map[uuid.UUID]int{}
	r, err := pool.Query(ctx, `SELECT track_id FROM playlist_tracks WHERE playlist_id = $1`, pl)
	if err != nil {
		t.Fatal(err)
	}
	for r.Next() {
		var id uuid.UUID
		if err := r.Scan(&id); err != nil {
			t.Fatal(err)
		}
		got[id]++
	}
	r.Close()
	if len(got) != 2 || got[rows[0]] != 1 || got[rows[1]] != 1 {
		t.Fatalf("entries after delete = %v; want one each on %v (single) and %v (album)", got, rows[0], rows[1])
	}
}

func TestDownloadCapsTheStreamBeforeTagging(t *testing.T) {
	prev := downloadfile.MaxFileBytes
	downloadfile.MaxFileBytes = 1 << 10
	t.Cleanup(func() { downloadfile.MaxFileBytes = prev })

	var spooled int64
	w := &Worker{
		source: &fakeSource{body: func() io.Reader { return zeroReader{} }}, // never ends
		tag: func(_ context.Context, r io.ReadCloser, _ []byte, _ mediaembed.Metadata, _ mediaembed.FormatHint) (*mediaembed.Result, error) {
			defer r.Close()
			n, err := io.Copy(io.Discard, r) // what Embed does with its temp input
			spooled = n
			return nil, err
		},
	}
	_, err := w.download(context.Background(), tidal.Track{ID: "1", Title: "Huge"}, t.TempDir())
	if !errors.Is(err, downloadfile.ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	if spooled > downloadfile.MaxFileBytes+1 {
		t.Fatalf("tagger spooled %d bytes past a %d byte cap", spooled, downloadfile.MaxFileBytes)
	}
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

// Stats and history that land on a retired TIDAL row after adoption (a play
// that resolved the old id just before the swap) move to the saved copy on
// the next drain. And a retry after adoption failed keeps the download's
// "downloaded" provenance instead of rediscovering the file as "existing".
func TestDrainRepairsRetiredRowsAndRetriedAdoptions(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	run := uuid.NewString()[:8]
	tid := "rr" + run
	pl, rows := optedInPlaylist(t, pool, tid)
	remote := rows[0]
	var owner uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT owner_id FROM playlists WHERE id = $1`, pl).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM tracks WHERE file_path LIKE $1`, root+"%") })
	w := testWorker(t, pool, root, &fakeSource{tracks: map[string]tidal.Track{tid: {ID: tid, Title: "Retired " + run}}})
	w.drain(ctx)
	local, err := w.Library.DownloadedTIDALTrack(ctx, tid)
	if err != nil {
		t.Fatal(err)
	}

	// A late play on the retired row.
	if _, err := pool.Exec(ctx, `INSERT INTO user_track_stats(user_id, track_id, play_count) VALUES($1, $2, 1)`, owner, remote); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO play_history(user_id, track_id) VALUES($1, $2)`, owner, remote); err != nil {
		t.Fatal(err)
	}
	// And an adoption that never happened: the entry is still on the remote
	// row, though the download was recorded.
	if _, err := pool.Exec(ctx, `UPDATE playlist_tracks SET track_id = $1, tidal_origin = NULL WHERE playlist_id = $2`, remote, pl); err != nil {
		t.Fatal(err)
	}
	w.drain(ctx)

	var leftover, localPlays int
	if err := pool.QueryRow(ctx, `
		SELECT (SELECT COUNT(*) FROM user_track_stats WHERE track_id = $1)
		     + (SELECT COUNT(*) FROM play_history WHERE track_id = $1)
		     + (SELECT COUNT(*) FROM playlist_tracks WHERE track_id = $1)`, remote).Scan(&leftover); err != nil {
		t.Fatal(err)
	}
	if leftover != 0 {
		t.Fatalf("%d references still on the retired row", leftover)
	}
	if err := pool.QueryRow(ctx, `SELECT play_count FROM user_track_stats WHERE user_id = $1 AND track_id = $2`,
		owner, local).Scan(&localPlays); err != nil || localPlays != 1 {
		t.Fatalf("saved copy plays = %d, %v; want 1", localPlays, err)
	}
	recent, _ := w.Store.Recent(ctx, 200)
	if d := findDownload(recent, tid); d == nil || d.Status != StatusDownloaded || d.LocalTrackID == nil || *d.LocalTrackID != local {
		t.Fatalf("provenance after retry = %+v, want downloaded → %v", d, local)
	}
}

func TestAdoptRefusesADeletedLocalCopy(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	run := uuid.NewString()[:8]
	tid := "ag" + run
	pl, rows := optedInPlaylist(t, pool, tid)
	_, libPath := libraryFile(t)
	local := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO tracks(id, title, duration_ms, file_path, file_size, format, audio_sha256, deleted_at)
		VALUES($1, 'Purged', 1000, $2, 5, 'flac', $3, NOW())`, local, libPath, local[:]); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM tracks WHERE id = $1`, local) })
	err := NewStore(pool).Adopt(ctx, Adoption{RowID: rows[0], TIDALID: tid, LocalID: local, Status: StatusExisting})
	if !errors.Is(err, ErrLocalGone) {
		t.Fatalf("err = %v, want ErrLocalGone", err)
	}
	var entry uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT track_id FROM playlist_tracks WHERE playlist_id = $1`, pl).Scan(&entry); err != nil || entry != rows[0] {
		t.Fatalf("entry = %v, %v; want it left on the TIDAL row", entry, err)
	}
}

// A downloaded copy that later also stands in for another TIDAL id (same
// ISRC) holds both tracks' merged history. Deleting it must not hand all of
// that to one of them; each playlist entry still returns to its own track.
func TestSharedDownloadedCopyDoesNotMisattributeHistory(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	run := uuid.NewString()[:8]
	first, second := "hf"+run, "hs"+run
	isrc := "HS" + strings.ToUpper(run)
	root := t.TempDir()
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM tracks WHERE file_path LIKE $1`, root+"%") })

	pl1, rows1 := optedInPlaylist(t, pool, first)
	w := testWorker(t, pool, root, &fakeSource{tracks: map[string]tidal.Track{
		first:  {ID: first, Title: "Song " + run},
		second: {ID: second, Title: "Song " + run, ISRC: isrc},
	}})
	w.drain(ctx)
	copyID, err := w.Library.DownloadedTIDALTrack(ctx, first)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE tracks SET isrc = $2 WHERE id = $1`, copyID, isrc); err != nil {
		t.Fatal(err)
	}
	pl2, rows2 := optedInPlaylist(t, pool, second)
	var listener uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT owner_id FROM playlists WHERE id = $1`, pl2).Scan(&listener); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO user_track_stats(user_id, track_id, play_count) VALUES($1, $2, 4)`, listener, rows2[0]); err != nil {
		t.Fatal(err)
	}
	w.drain(ctx)
	if got, err := w.Library.DownloadedTIDALTrack(ctx, second); err != nil || got != copyID {
		t.Fatalf("second resolved to %v, %v; want the shared copy %v", got, err, copyID)
	}

	path, err := w.Store.TrackFilePath(ctx, copyID)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Library.HardDeleteByPath(ctx, path); err != nil {
		t.Fatal(err)
	}
	var misattributed int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM user_track_stats WHERE track_id = $1`, rows1[0]).Scan(&misattributed); err != nil {
		t.Fatal(err)
	}
	if misattributed != 0 {
		t.Fatalf("the first TIDAL track received %d stats rows from the shared copy", misattributed)
	}
	for pl, want := range map[uuid.UUID]uuid.UUID{pl1: rows1[0], pl2: rows2[0]} {
		var entry uuid.UUID
		if err := pool.QueryRow(ctx, `SELECT track_id FROM playlist_tracks WHERE playlist_id = $1`, pl).Scan(&entry); err != nil || entry != want {
			t.Fatalf("playlist %v entry = %v, %v; want its own TIDAL track %v", pl, entry, err, want)
		}
	}
}
