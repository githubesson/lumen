package ingest

import (
	"os"
	"path/filepath"
	"testing"
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
