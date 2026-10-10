package ingest

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
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
