package filen

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/githubesson/lumen/internal/db"
)

// helperScanner runs scanPin against a stand-in helper script.
func helperScanner(t *testing.T, code string) (*Scanner, Pin) {
	t.Helper()
	url := os.Getenv("LUMEN_REVIEW_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set LUMEN_REVIEW_TEST_DATABASE_URL to an isolated PostgreSQL database")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node unavailable")
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
	pin, err := store.AddPin(ctx, AddPinInput{RootPath: t.TempDir(), ShareURL: "https://drive.filen.io/f/test#key"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.DeletePin(context.Background(), pin.ID) })
	script := filepath.Join(t.TempDir(), "helper.mjs")
	if err := os.WriteFile(script, []byte(code), 0o600); err != nil {
		t.Fatal(err)
	}
	return &Scanner{Store: store, NodePath: node, ScriptPath: script, FileTimeout: 300 * time.Millisecond}, pin
}

func lowerHelperGraces(t *testing.T, idle, stop time.Duration) {
	t.Helper()
	oldIdle, oldStop := helperIdleGrace, helperStopGrace
	helperIdleGrace, helperStopGrace = idle, stop
	t.Cleanup(func() { helperIdleGrace, helperStopGrace = oldIdle, oldStop })
}

// The timeout is per file: a share that keeps finishing files runs past it.
func TestScanOutlastsFileTimeoutWhileHelperProgresses(t *testing.T) {
	lowerHelperGraces(t, 0, time.Second)
	scanner, pin := helperScanner(t, `
for (let i = 0; i < 6; i++) {
  console.log(JSON.stringify({event: "file", status: "skipped", relPath: "notes" + i + ".txt", size: 1, error: "unsupported file extension"}))
  await new Promise(r => setTimeout(r, 150))
}
`)
	start := time.Now()
	var summary ScanSummary
	if err := scanner.scanPin(context.Background(), pin, &summary); err != nil {
		t.Fatal(err)
	}
	if summary.Skipped != 6 || time.Since(start) < scanner.FileTimeout {
		t.Fatalf("summary %+v after %v", summary, time.Since(start))
	}
}

// A helper that goes quiet for longer than a file may take is stopped with
// SIGTERM, which lets it remove its partial file, and the scan fails.
func TestScanStopsStalledHelperWithSIGTERM(t *testing.T) {
	lowerHelperGraces(t, 0, 5*time.Second)
	marker := filepath.Join(t.TempDir(), "terminated")
	scanner, pin := helperScanner(t, `
import { writeFileSync } from "node:fs"
process.on("SIGTERM", () => { writeFileSync(`+"`"+marker+"`"+`, "x"); process.exit(143) })
setInterval(() => {}, 1000)
`)
	var summary ScanSummary
	err := scanner.scanPin(context.Background(), pin, &summary)
	if err == nil || !strings.Contains(err.Error(), "stalled") {
		t.Fatalf("scan err = %v", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("helper was not sent SIGTERM: %v", err)
	}
}

// One that ignores SIGTERM is killed after the stop grace.
func TestScanKillsHelperIgnoringSIGTERM(t *testing.T) {
	lowerHelperGraces(t, 0, 200*time.Millisecond)
	scanner, pin := helperScanner(t, `
process.on("SIGTERM", () => {})
setInterval(() => {}, 1000)
`)
	done := make(chan error, 1)
	go func() {
		var summary ScanSummary
		done <- scanner.scanPin(context.Background(), pin, &summary)
	}()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "stalled") {
			t.Fatalf("scan err = %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("scan still waiting on a helper that ignores SIGTERM")
	}
}

// A helper writing more to stderr than the scan keeps still finishes, and a
// failure reports the end of what it wrote.
func TestScanDrainsChattyHelperStderr(t *testing.T) {
	lowerHelperGraces(t, 0, time.Second)
	const noise = `
const line = "warning ".repeat(127) + "\n"
for (let i = 0; i < 1024; i++) process.stderr.write(line)
`
	scanner, pin := helperScanner(t, noise+`
console.log(JSON.stringify({event: "file", status: "skipped", relPath: "notes.txt", size: 1, error: "unsupported file extension"}))
`)
	var summary ScanSummary
	if err := scanner.scanPin(context.Background(), pin, &summary); err != nil || summary.Skipped != 1 {
		t.Fatalf("scan err = %v, summary %+v", err, summary)
	}

	scanner, pin = helperScanner(t, noise+`
process.stderr.write("share link expired\n")
process.exitCode = 1
`)
	err := scanner.scanPin(context.Background(), pin, &ScanSummary{})
	if err == nil || !strings.HasSuffix(err.Error(), "share link expired") {
		t.Fatalf("scan err = %v", err)
	}
}
