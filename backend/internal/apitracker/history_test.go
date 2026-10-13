package apitracker

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"

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

// A track downloaded earlier keeps edits made in Lumen until the tracker's
// tags for it change, and its album gets the era cover once, not every scan.
func TestRescanKeepsEditsUntilTrackerChanges(t *testing.T) {
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
	pin, err := store.AddPin(ctx, AddPinInput{APIBaseURL: "https://tracker.example/api", TrackerID: 2, RootPath: root})
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
		Store:   store,
		Library: lib,
		Ingest: &ingest.Service{
			DB: pool, Library: lib, Storage: storage.NewLocal(root), MusicRoot: root,
			Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		},
	}

	path := filepath.Join(root, "song.flac")
	if err := os.WriteFile(path, []byte("audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	trackID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO tracks(id,title,duration_ms,file_path,file_size,format,audio_sha256) VALUES($1,'From tags',1000,$2,5,'flac',$3)`, trackID, path, trackID[:]); err != nil {
		t.Fatal(err)
	}
	tracker := Tracker{TrackerName: artist + " Tracker"}
	entry := Entry{ID: 5, RowNumber: 3, Name: "Song", Era: era, Type: "Leak"}
	sourceURL := "https://files.example/" + sfx
	title := func() string {
		t.Helper()
		var got string
		if err := pool.QueryRow(ctx, `SELECT title FROM tracks WHERE id=$1`, trackID).Scan(&got); err != nil {
			t.Fatal(err)
		}
		return got
	}
	edit := func(to string) {
		t.Helper()
		if err := lib.UpdateTrack(ctx, trackID, library.TrackPatch{Title: &to}); err != nil {
			t.Fatal(err)
		}
	}
	scan := func(e Entry) {
		t.Helper()
		var summary ScanSummary
		run := loadRun(t, store, pin, &summary)
		run.covers = eraCovers{client: client, images: map[string]int64{normalizeEraKey(era): 9}, keys: map[int64]string{}}
		tc := BuildContext(tracker, pin, e)
		if !scanner.previousStillPresent(ctx, run, sourceURL, entryMetadata(tracker, pin, e, tc), tc) || summary.Existing != 1 {
			t.Fatalf("download not settled: %+v", summary)
		}
	}

	// The first download applied the tracker's tags and recorded them.
	tc := BuildContext(tracker, pin, entry)
	scanner.applyTrackerMetadata(ctx, trackID, tc)
	if err := store.RecordDownload(ctx, DownloadInput{
		PinID: pin.ID, EntryID: entry.ID, SourceURL: sourceURL, FilePath: path,
		Status: StatusDownloaded, TrackID: &trackID, Metadata: entryMetadata(tracker, pin, entry, tc),
	}); err != nil {
		t.Fatal(err)
	}

	edit("My title")
	scan(entry)
	if got := title(); got != "My title" {
		t.Fatalf("unchanged tracker reverted the edit to %q", got)
	}
	var cover string
	if err := pool.QueryRow(ctx, `SELECT COALESCE(a.cover_art_path,'') FROM tracks t JOIN albums a ON a.id=t.album_id WHERE t.id=$1`, trackID).Scan(&cover); err != nil || cover == "" {
		t.Fatalf("album cover = %q, %v", cover, err)
	}
	if n := imageHits.Load(); n != 1 {
		t.Fatalf("era image fetched %d times", n)
	}

	// A row inserted above moves the entry without changing its tags.
	moved := entry
	moved.RowNumber = 4
	scan(moved)
	if got := title(); got != "My title" {
		t.Fatalf("moved row reverted the edit to %q", got)
	}
	if n := imageHits.Load(); n != 1 {
		t.Fatalf("era image fetched again for an album with a cover: %d", n)
	}

	renamed := moved
	renamed.Name = "Song (Remix)"
	scan(renamed)
	if got := title(); got != "Song (Remix)" {
		t.Fatalf("tracker change not applied: %q", got)
	}
	edit("Mine again")
	scan(renamed)
	if got := title(); got != "Mine again" {
		t.Fatalf("second scan reverted the edit to %q", got)
	}
}

func TestRecordedSkipsAreFinal(t *testing.T) {
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
		`unsupported file extension ".txt"`: true,
		"download URL host is not allowed":  true,
		"destination is read-only":          false,
		"unsupported file extension":        false,
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
