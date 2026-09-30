package artistgrid

import (
	"context"
	"encoding/binary"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/storage"
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

// writeTestFLAC writes a minimal FLAC carrying audio, tagged with Vorbis
// comments ("KEY=value"). Files sharing audio dedup into one track.
func writeTestFLAC(t *testing.T, path, audio string, comments ...string) {
	t.Helper()
	block := func(typ byte, last bool, body []byte) []byte {
		h := []byte{typ, byte(len(body) >> 16), byte(len(body) >> 8), byte(len(body))}
		if last {
			h[0] |= 0x80
		}
		return append(h, body...)
	}
	le := binary.LittleEndian.AppendUint32
	streaminfo := make([]byte, 34)
	binary.BigEndian.PutUint64(streaminfo[10:18], uint64(44100)<<44|uint64(1)<<41|uint64(15)<<36|88200)
	data := append([]byte("fLaC"), block(0, len(comments) == 0, streaminfo)...)
	if len(comments) > 0 {
		vc := le(nil, 4)
		vc = append(vc, "test"...)
		vc = le(vc, uint32(len(comments)))
		for _, c := range comments {
			vc = le(vc, uint32(len(c)))
			vc = append(vc, c...)
		}
		data = append(data, block(4, true, vc)...)
	}
	data = append(data, audio...)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

// A download whose tags beat an existing copy's becomes that track's file,
// so the tracker's metadata applies to it as it would to a new track.
func TestIngestPathAppliesTrackerMetadataToAdoptedDownload(t *testing.T) {
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
	lib := library.NewStore(pool)
	root := t.TempDir()
	sfx := uuid.NewString()[:8]
	artist, album, era := "AG Artist "+sfx, "AG Album "+sfx, "AG Era "+sfx
	t.Cleanup(func() {
		bg := context.Background()
		pool.Exec(bg, `DELETE FROM tracks WHERE starts_with(file_path,$1)`, root)
		pool.Exec(bg, `DELETE FROM albums a WHERE title IN ($1,$2,'Others') AND NOT EXISTS(SELECT 1 FROM tracks t WHERE t.album_id=a.id)`, album, era)
		pool.Exec(bg, `DELETE FROM artists WHERE name = $1`, artist)
	})
	svc := &ingest.Service{
		DB: pool, Library: lib, Storage: storage.NewLocal(root), MusicRoot: root,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	scanner := Scanner{Ingest: svc, Library: lib}
	audio := "artistgrid-adopt-" + sfx
	og := filepath.Join(root, "og.flac")
	writeTestFLAC(t, og, audio)
	first := svc.IngestFile(ctx, og)
	if first.Err != nil || !first.Inserted {
		t.Fatalf("original ingest = %+v", first)
	}
	title := func() string {
		t.Helper()
		var got string
		if err := pool.QueryRow(ctx, `SELECT title FROM tracks WHERE id=$1`, first.TrackID).Scan(&got); err != nil {
			t.Fatal(err)
		}
		return got
	}

	// No fuller than the original: stays an alias, so the tracker's metadata
	// isn't this track's to apply.
	bare := filepath.Join(root, "dl", "bare.flac")
	writeTestFLAC(t, bare, audio)
	if id, inserted := scanner.ingestPath(ctx, bare, TrackContext{Title: "Not applied"}, true); id == nil || *id != first.TrackID || inserted {
		t.Fatalf("bare download = %v, %v", id, inserted)
	}
	if got := title(); got != "og" {
		t.Fatalf("title after a non-adopted download = %q", got)
	}

	tagged := filepath.Join(root, "dl", "tagged.flac")
	writeTestFLAC(t, tagged, audio, "TITLE=Tagged", "ARTIST="+artist, "ALBUM="+album)
	id, inserted := scanner.ingestPath(ctx, tagged, TrackContext{Title: "Tracker title", Artist: artist, Album: era}, true)
	if id == nil || *id != first.TrackID || inserted {
		t.Fatalf("tagged download = %v, %v", id, inserted)
	}
	if got := title(); got != "Tracker title" {
		t.Fatalf("title after an adopted download = %q", got)
	}
}
