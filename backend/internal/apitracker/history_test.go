package apitracker

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/storage"
)

func TestCompareEntryMetadata(t *testing.T) {
	tracker := Tracker{TrackerName: "Artist Tracker"}
	entry := Entry{ID: 1, RowNumber: 10, Name: "Song", Era: "Era", Type: "Leak"}
	base := entryMetadata(tracker, Pin{}, entry, BuildContext(tracker, Pin{}, entry))
	moved := entry
	moved.RowNumber = 11
	renamed := entry
	renamed.Name = "Song (v2)"
	for _, tc := range []struct {
		name                string
		prev, next          json.RawMessage
		wantTags, wantDiffs bool
	}{
		{"same", base, base, false, false},
		{"row moved", base, entryMetadata(tracker, Pin{}, moved, BuildContext(tracker, Pin{}, moved)), false, true},
		{"title changed", base, entryMetadata(tracker, Pin{}, renamed, BuildContext(tracker, Pin{}, renamed)), true, true},
		// Recorded before year/genre/comment were: not a tag change.
		{"older record", json.RawMessage(`{"title":"Song","era":"Era","primary_artist":"Artist","featured":[],"producer":""}`), base, false, true},
		{"no record", nil, base, true, true},
	} {
		tags, differs := compareEntryMetadata(tc.prev, tc.next)
		if tags != tc.wantTags || differs != tc.wantDiffs {
			t.Errorf("%s: tags=%v differs=%v, want %v %v", tc.name, tags, differs, tc.wantTags, tc.wantDiffs)
		}
	}
}

func testPNG(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 4, 4))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// rescanFixture is a pin with one earlier download: a track playing from
// song.flac under the pin's root, recorded with entry's tags, which the
// download applied.
type rescanFixture struct {
	ctx       context.Context
	pool      *pgxpool.Pool
	store     *Store
	lib       *library.Store
	pin       Pin
	root      string
	trackID   uuid.UUID
	tracker   Tracker
	entry     Entry
	era       string
	sourceURL string
}

func newRescanFixture(t *testing.T, trackerID int64) *rescanFixture {
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
	root := t.TempDir()
	store := NewStore(pool)
	pin, err := store.AddPin(ctx, AddPinInput{APIBaseURL: "https://tracker.example/api", TrackerID: trackerID, RootPath: root})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.DeletePin(context.Background(), pin.ID) })
	lib := library.NewStore(pool)
	sfx := uuid.NewString()[:8]
	artist, era := "Rescan Artist "+sfx, "Rescan Era "+sfx
	t.Cleanup(func() {
		bg := context.Background()
		pool.Exec(bg, `DELETE FROM tracks WHERE starts_with(file_path,$1)`, root)
		pool.Exec(bg, `DELETE FROM albums WHERE title = $1`, era)
		pool.Exec(bg, `DELETE FROM artists WHERE name = $1`, artist)
	})

	path := filepath.Join(root, "song.flac")
	if err := os.WriteFile(path, []byte("audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	trackID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO tracks(id,title,duration_ms,file_path,file_size,format,audio_sha256) VALUES($1,'From tags',1000,$2,5,'flac',$3)`, trackID, path, trackID[:]); err != nil {
		t.Fatal(err)
	}
	f := &rescanFixture{
		ctx: ctx, pool: pool, store: store, lib: lib, pin: pin, root: root, trackID: trackID,
		tracker:   Tracker{TrackerName: artist + " Tracker"},
		entry:     Entry{ID: 5, RowNumber: 3, Name: "Song", Era: era, Type: "Leak"},
		era:       era,
		sourceURL: "https://files.example/" + sfx,
	}
	tc := BuildContext(f.tracker, pin, f.entry)
	if err := (&Scanner{Library: lib}).applyTrackerMetadata(ctx, trackID, tc); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordDownload(ctx, DownloadInput{
		PinID: pin.ID, EntryID: f.entry.ID, SourceURL: f.sourceURL, FilePath: path,
		Status: StatusDownloaded, TrackID: &trackID, Metadata: entryMetadata(f.tracker, pin, f.entry, tc),
	}); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *rescanFixture) title(t *testing.T) string {
	t.Helper()
	var got string
	if err := f.pool.QueryRow(f.ctx, `SELECT title FROM tracks WHERE id=$1`, f.trackID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	return got
}

func (f *rescanFixture) edit(t *testing.T, to string) {
	t.Helper()
	if err := f.lib.UpdateTrack(f.ctx, f.trackID, library.TrackPatch{Title: &to}); err != nil {
		t.Fatal(err)
	}
}

// run starts a scan of the fixture's pin.
func (f *rescanFixture) run(t *testing.T) *scanRun {
	t.Helper()
	var summary ScanSummary
	return loadRun(t, f.store, f.pin, &summary)
}

// settle has each of entries, all listing the fixture's link, settle it in
// run as the earlier download.
func (f *rescanFixture) settle(t *testing.T, scanner *Scanner, run *scanRun, entries ...Entry) {
	t.Helper()
	for _, e := range entries {
		tc := BuildContext(f.tracker, f.pin, e)
		if !scanner.previousStillPresent(f.ctx, run, f.sourceURL, entryMetadata(f.tracker, f.pin, e, tc), tc) {
			t.Fatalf("download not settled for entry %d: %+v", e.ID, run.summary)
		}
	}
	if run.summary.Existing != len(entries) {
		t.Fatalf("summary %+v, want %d existing", run.summary, len(entries))
	}
}

// A track downloaded earlier keeps edits made in Lumen until the tracker's
// tags for it change, and its album gets the era cover once, not every scan.
func TestRescanKeepsEditsUntilTrackerChanges(t *testing.T) {
	f := newRescanFixture(t, 2)
	var imageHits atomic.Int32
	img := testPNG(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		imageHits.Add(1)
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(img)
	}))
	t.Cleanup(srv.Close)
	client := NewClient(srv.URL)
	client.HTTP = srv.Client()
	scanner := Scanner{
		Store:   f.store,
		Library: f.lib,
		Ingest: &ingest.Service{
			DB: f.pool, Library: f.lib, Storage: storage.NewLocal(f.root), MusicRoot: f.root,
			Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		},
	}
	scan := func(e Entry) {
		t.Helper()
		run := f.run(t)
		run.covers = eraCovers{client: client, images: map[string]int64{normalizeEraKey(f.era): 9}, keys: map[int64]string{}}
		f.settle(t, &scanner, run, e)
	}

	f.edit(t, "My title")
	scan(f.entry)
	if got := f.title(t); got != "My title" {
		t.Fatalf("unchanged tracker reverted the edit to %q", got)
	}
	var cover string
	if err := f.pool.QueryRow(f.ctx, `SELECT COALESCE(a.cover_art_path,'') FROM tracks t JOIN albums a ON a.id=t.album_id WHERE t.id=$1`, f.trackID).Scan(&cover); err != nil || cover == "" {
		t.Fatalf("album cover = %q, %v", cover, err)
	}
	if n := imageHits.Load(); n != 1 {
		t.Fatalf("era image fetched %d times", n)
	}

	// A row inserted above moves the entry without changing its tags.
	moved := f.entry
	moved.RowNumber = 4
	scan(moved)
	if got := f.title(t); got != "My title" {
		t.Fatalf("moved row reverted the edit to %q", got)
	}
	if n := imageHits.Load(); n != 1 {
		t.Fatalf("era image fetched again for an album with a cover: %d", n)
	}

	renamed := moved
	renamed.Name = "Song (Remix)"
	scan(renamed)
	if got := f.title(t); got != "Song (Remix)" {
		t.Fatalf("tracker change not applied: %q", got)
	}
	f.edit(t, "Mine again")
	scan(renamed)
	if got := f.title(t); got != "Mine again" {
		t.Fatalf("second scan reverted the edit to %q", got)
	}
}

// A tracker change that fails to apply isn't recorded as applied: the next
// scan still sees it and tries again.
func TestRescanRetriesFailedTagChange(t *testing.T) {
	f := newRescanFixture(t, 4)
	scanner := &Scanner{Store: f.store, Library: f.lib}
	renamed := f.entry
	renamed.Name = "Song (Remix)"
	tc := BuildContext(f.tracker, f.pin, renamed)
	metadata := entryMetadata(f.tracker, f.pin, renamed, tc)

	// A year the tracks table can't hold fails the whole update.
	broken := tc
	broken.Year = math.MaxInt32 + 1
	run := f.run(t)
	if !scanner.previousStillPresent(f.ctx, run, f.sourceURL, metadata, broken) {
		t.Fatal("download not settled")
	}
	if got := f.title(t); got != "Song" {
		t.Fatalf("title after a failed update = %q", got)
	}

	f.settle(t, scanner, f.run(t), renamed)
	if got := f.title(t); got != "Song (Remix)" {
		t.Fatalf("change not applied on the scan after the failure: title %q", got)
	}
}

// A link listed under two entries with different tags keeps the first
// entry's: the second used to re-apply its own, and the next scan the
// first's again, every scan stamping the track as edited.
func TestLinkListedTwiceKeepsFirstEntrysTags(t *testing.T) {
	f := newRescanFixture(t, 5)
	scanner := &Scanner{Store: f.store, Library: f.lib}
	other := f.entry
	other.ID, other.RowNumber, other.Name = 6, 9, "Song (Alt)"

	f.settle(t, scanner, f.run(t), f.entry, other)
	if got := f.title(t); got != "Song" {
		t.Fatalf("title after the first scan = %q", got)
	}
	f.edit(t, "My title")
	f.settle(t, scanner, f.run(t), f.entry, other)
	if got := f.title(t); got != "My title" {
		t.Fatalf("second scan re-applied tags: title %q", got)
	}
}

// A link recorded as skipped isn't resolved and requested again while the
// reason is about the link and still holds; any other skip is retried.
func TestRecordedSkipFinality(t *testing.T) {
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
	store := NewStore(pool)
	pin, err := store.AddPin(ctx, AddPinInput{APIBaseURL: "https://tracker.example/api", TrackerID: 3, RootPath: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.DeletePin(context.Background(), pin.ID) })
	reasons := map[string]bool{
		"skipped host":                      true,
		`unsupported file extension ".txt"`: true,
		// Recorded when ingest couldn't read .flac yet.
		`unsupported file extension ".flac"`: false,
		"no file extension":                  false,
		"download URL host is not allowed":   false,
		"destination is read-only":           false,
		"unsupported file extension":         false,
	}
	for reason := range reasons {
		if err := store.RecordDownload(ctx, DownloadInput{PinID: pin.ID, SourceURL: "https://files.example/" + reason, Status: StatusSkipped, Error: reason}); err != nil {
			t.Fatal(err)
		}
	}
	scanner := Scanner{Store: store}
	for reason, final := range reasons {
		var summary ScanSummary
		run := loadRun(t, store, pin, &summary)
		if got := scanner.previousStillPresent(ctx, run, "https://files.example/"+reason, nil, TrackContext{}); got != final || (summary.Skipped == 1) != final {
			t.Errorf("%q: settled=%v skipped=%d, want final=%v", reason, got, summary.Skipped, final)
		}
	}
}
