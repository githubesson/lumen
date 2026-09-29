package ingest

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestUniqueScanRootsPreservesSeparatelyScannedDirectories(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "artist", "album")
	hidden := filepath.Join(root, ".archive", "album")
	for _, dir := range []string{nested, hidden} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	separate := t.TempDir()
	for _, roots := range [][]string{
		{nested, root, root, hidden, separate},
		{root, nested, root, hidden, separate},
	} {
		if got := uniqueScanRoots(roots); !reflect.DeepEqual(got, []string{root, hidden, separate}) {
			t.Fatalf("roots %v became %v", roots, got)
		}
	}
	link := filepath.Join(root, "linked")
	if err := os.Symlink(separate, link); err == nil {
		throughLink := filepath.Join(link, "album")
		if err := os.MkdirAll(throughLink, 0700); err != nil {
			t.Fatal(err)
		}
		if got := uniqueScanRoots([]string{root, throughLink}); len(got) != 2 {
			t.Fatalf("root behind a symlink was excluded: %v", got)
		}
	}
}
