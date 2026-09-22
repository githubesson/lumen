package artistgrid

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/library"
	"github.com/google/uuid"
)

func TestPreviousStillPresentAfterDedup(t *testing.T) {
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
	store := NewStore(pool)
	pin, err := store.AddPin(ctx, AddPinInput{TrackerID: "test", RootPath: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer store.DeletePin(ctx, pin.ID)
	scanner := Scanner{Store: store, Library: library.NewStore(pool)}
	for _, tc := range []struct {
		name      string
		status    string
		canonical string
		deleted   bool
		linked    bool
		original  bool
		want      bool
	}{
		{"downloaded duplicate", StatusDownloaded, "audio", false, true, false, true},
		{"existing duplicate", StatusExisting, "audio", false, true, false, true},
		{"missing canonical", StatusDownloaded, "", false, true, false, false},
		{"empty canonical", StatusDownloaded, "empty", false, true, false, false},
		{"deleted canonical", StatusDownloaded, "audio", true, true, false, false},
		{"no track link", StatusDownloaded, "audio", false, false, false, false},
		{"failed download", StatusFailed, "audio", false, true, false, false},
		{"original file remains", StatusExisting, "", false, false, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			original := filepath.Join(dir, "duplicate.mp3")
			canonical := filepath.Join(dir, "canonical.mp3")
			if tc.canonical != "" {
				data := []byte("audio")
				if tc.canonical == "empty" {
					data = nil
				}
				if err := os.WriteFile(canonical, data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if tc.original {
				if err := os.WriteFile(original, []byte("audio"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			id := uuid.New()
			var trackID *uuid.UUID
			if tc.linked {
				_, err := pool.Exec(ctx, `INSERT INTO tracks(id,title,duration_ms,file_path,file_size,format,audio_sha256,deleted_at) VALUES($1,'Canonical title',1000,$2,5,'mp3',$3,CASE WHEN $4 THEN NOW() END)`, id, canonical, id[:], tc.deleted)
				if err != nil {
					t.Fatal(err)
				}
				defer pool.Exec(ctx, `DELETE FROM tracks WHERE id=$1`, id)
				trackID = &id
			}
			sourceURL := "https://files.example/" + id.String()
			if err := store.RecordDownload(ctx, DownloadInput{PinID: pin.ID, SourceURL: sourceURL, FilePath: original, Status: tc.status, TrackID: trackID}); err != nil {
				t.Fatal(err)
			}
			// Existing history retains the now-deleted duplicate path. Repeated scans
			// must use its canonical link without recreating or retagging either file.
			for i := 0; i < 2; i++ {
				summary := ScanSummary{}
				if got := scanner.previousStillPresent(ctx, pin.ID, sourceURL, &summary); got != tc.want {
					t.Fatalf("present = %v, want %v", got, tc.want)
				}
				wantExisting := 0
				if tc.want {
					wantExisting = 1
				}
				if summary.Existing != wantExisting || summary.Downloaded != 0 || summary.Ingested != 0 {
					t.Fatalf("unexpected summary: %+v", summary)
				}
			}
			if tc.linked {
				var title string
				if err := pool.QueryRow(ctx, `SELECT title FROM tracks WHERE id=$1`, id).Scan(&title); err != nil {
					t.Fatal(err)
				}
				if title != "Canonical title" {
					t.Fatalf("canonical metadata changed: %q", title)
				}
			}
		})
	}
}
