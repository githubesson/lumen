package filen

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/githubesson/lumen/internal/db"
	"github.com/google/uuid"
)

func TestRetainedDownloadHistory(t *testing.T) {
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
	pin, err := store.AddPin(ctx, AddPinInput{RootPath: t.TempDir(), ShareURL: "https://drive.filen.io/f/test#key"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.DeletePin(ctx, pin.ID)
	scanner := Scanner{Store: store}
	canonical := filepath.Join(t.TempDir(), "canonical.mp3")
	if err := os.WriteFile(canonical, []byte("audio with tags"), 0600); err != nil {
		t.Fatal(err)
	}
	id := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO tracks(id,title,duration_ms,file_path,file_size,format,audio_sha256) VALUES($1,'Canonical',1000,$2,15,'mp3',$3)`, id, canonical, id[:]); err != nil {
		t.Fatal(err)
	}
	defer pool.Exec(ctx, `DELETE FROM tracks WHERE id=$1`, id)
	original := filepath.Join(pin.RootPath, "duplicate.mp3")
	if err := store.RecordDownload(ctx, DownloadInput{PinID: pin.ID, SourcePath: "duplicate.mp3", FilePath: original, SizeBytes: 5, Status: StatusDownloaded, TrackID: &id}); err != nil {
		t.Fatal(err)
	}
	retained, err := store.retainedFiles(ctx, pin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := retained["duplicate.mp3"]; got.Path != canonical || got.Size != 5 || got.FileSize != 15 {
		t.Fatalf("unexpected manifest: %+v", retained)
	}

	t.Run("helper receives history through stdin", func(t *testing.T) {
		node, err := exec.LookPath("node")
		if err != nil {
			t.Skip("node unavailable")
		}
		script := filepath.Join(t.TempDir(), "helper.mjs")
		code := `
if (!process.argv.includes("--retained-stdin")) throw Error("missing manifest flag")
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const manifest = JSON.parse(Buffer.concat(chunks).toString("utf8"))
if (manifest["duplicate.mp3"]?.fileSize !== 15) throw Error("missing canonical file")
console.log(JSON.stringify({event:"file",status:"existing",retained:true,relPath:"duplicate.mp3",size:5}))
`
		if err := os.WriteFile(script, []byte(code), 0600); err != nil {
			t.Fatal(err)
		}
		scanner.NodePath, scanner.ScriptPath = node, script
		summary := ScanSummary{}
		if err := scanner.scanPin(ctx, pin, &summary); err != nil {
			t.Fatal(err)
		}
		if summary.Seen != 1 || summary.Existing != 1 || summary.Downloaded != 0 || summary.Ingested != 0 {
			t.Fatalf("unexpected summary: %+v", summary)
		}
		history, err := store.DownloadForSource(ctx, pin.ID, "duplicate.mp3")
		if err != nil {
			t.Fatal(err)
		}
		if history.TrackID == nil || *history.TrackID != id || history.FilePath != original {
			t.Fatalf("history changed: %+v", history)
		}
	})

	files, err := store.retainedFiles(ctx, uuid.New())
	if err != nil || len(files) != 0 {
		t.Fatalf("different pin: files=%v err=%v", files, err)
	}
	for _, status := range []string{StatusFailed, StatusSkipped, StatusExisting, StatusDownloaded} {
		if _, err := pool.Exec(ctx, `UPDATE filen_downloads SET status=$2 WHERE pin_id=$1`, pin.ID, status); err != nil {
			t.Fatal(err)
		}
		files, err := store.retainedFiles(ctx, pin.ID)
		if err != nil {
			t.Fatal(err)
		}
		want := status == StatusExisting || status == StatusDownloaded
		if (len(files) > 0) != want {
			t.Fatalf("status %s: manifest=%v", status, files)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE tracks SET deleted_at=NOW() WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	files, err = store.retainedFiles(ctx, pin.ID)
	if err != nil || len(files) != 0 {
		t.Fatalf("deleted track: files=%v err=%v", files, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE tracks SET deleted_at=NULL WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(canonical); err != nil {
		t.Fatal(err)
	}
	files, err = store.retainedFiles(ctx, pin.ID)
	if err != nil || len(files) != 0 {
		t.Fatalf("missing track: files=%v err=%v", files, err)
	}
}

func TestReadEventsRejectsInvalidRetainedFiles(t *testing.T) {
	canonical := filepath.Join(t.TempDir(), "canonical.mp3")
	if err := os.WriteFile(canonical, []byte("audio"), 0600); err != nil {
		t.Fatal(err)
	}
	retained := map[string]retainedFile{"song.mp3": {Path: canonical, Size: 10, FileSize: 5}}
	for _, event := range []string{
		`{"event":"file","retained":true,"relPath":"unknown.mp3","status":"existing","size":10}`,
		`{"event":"file","retained":true,"relPath":"song.mp3","status":"downloaded","size":10}`,
		`{"event":"file","retained":true,"relPath":"song.mp3","status":"existing","size":11}`,
	} {
		summary := ScanSummary{}
		if err := (&Scanner{}).readEvents(context.Background(), Pin{}, t.TempDir(), strings.NewReader(event), &summary, retained); err == nil {
			t.Fatal("accepted invalid retained event")
		}
		if summary.Existing != 0 {
			t.Fatal("counted invalid retained event")
		}
	}
}
