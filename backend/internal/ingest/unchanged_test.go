package ingest

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestUnchangedSince(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.flac")
	if err := os.WriteFile(path, []byte("audio"), 0600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !unchangedSince(path, before) {
		t.Fatal("untouched file reported changed")
	}
	later := before.ModTime().Add(time.Second)
	if err := os.Chtimes(path, later, later); err != nil {
		t.Fatal(err)
	}
	if unchangedSince(path, before) {
		t.Fatal("new mtime not noticed")
	}
	// Replaced by another file with the same size and time.
	other := filepath.Join(dir, "b.flac")
	if err := os.WriteFile(other, []byte("AUDIO"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(other, before.ModTime(), before.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(other, path); err != nil {
		t.Fatal(err)
	}
	if unchangedSince(path, before) {
		t.Fatal("replaced file not noticed")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if unchangedSince(path, before) {
		t.Fatal("removed file reported unchanged")
	}
}
