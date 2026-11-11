package ingest

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

func TestDeletedTreePrefix(t *testing.T) {
	p := filepath.Join("music", "tracker")
	got := deletedTreePrefix(p)
	want := filepath.Clean(p) + string(os.PathSeparator)
	if got != want {
		t.Fatalf("deletedTreePrefix() = %q, want %q", got, want)
	}
}

func TestDeletedTreePrefixBlank(t *testing.T) {
	if got := deletedTreePrefix("   "); got != "" {
		t.Fatalf("deletedTreePrefix(blank) = %q, want empty", got)
	}
}

// A panic while ingesting a watched file is logged, not fatal: the debounce
// timer runs the ingest on its own goroutine, where nothing else would
// recover it. A Service with no database panics once it gets to the insert.
func TestWatcherRecoversIngestPanic(t *testing.T) {
	logged := logTo(t)
	w := NewWatcher(&Service{})
	w.debounce = time.Millisecond
	w.schedule(context.Background(), writeVorbisFLAC(t, "TITLE=Song"))
	timeout := time.After(10 * time.Second)
	for {
		select {
		case msg := <-logged:
			if msg != "goroutine panicked" {
				continue
			}
			// The concurrency slot is released on the way out.
			if n := len(w.sem); n != 0 {
				t.Fatalf("%d ingest slots still taken", n)
			}
			return
		case <-timeout:
			t.Fatal("no recovered panic was logged")
		}
	}
}

// MUSIC_ROOT/.users appears at runtime with the first personal upload; the
// watcher must not take its files in as shared-library tracks.
func TestWatcherIgnoresNewHiddenDir(t *testing.T) {
	root := t.TempDir()
	hidden := filepath.Join(root, ".users")
	if err := os.MkdirAll(filepath.Join(hidden, "someone"), 0o755); err != nil {
		t.Fatal(err)
	}
	src := writeVorbisFLAC(t, "TITLE=Mine")
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hidden, "someone", "mine.flac"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	w := NewWatcher(&Service{})
	w.handle(context.Background(), fsnotify.Event{Name: hidden, Op: fsnotify.Create})
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.pending) != 0 {
		t.Fatalf("scheduled %d personal uploads for shared ingest", len(w.pending))
	}
	if len(w.watchSet) != 0 {
		t.Fatalf("watching %v under a hidden dir", w.watchSet)
	}
}
