package musicroots

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestMeasureUsageNestedRoots(t *testing.T) {
	dir := t.TempDir()
	primary := filepath.Join(dir, "music")
	artist := filepath.Join(primary, "artist")
	// A sibling whose name starts with the nested root's must not count
	// toward it.
	writeFile(t, filepath.Join(primary, "loose.flac"), 10)
	writeFile(t, filepath.Join(artist, "album", "01.flac"), 100)
	writeFile(t, filepath.Join(artist, "album", "cover.jpg"), 5)
	writeFile(t, filepath.Join(primary, "artist2", "02.flac"), 1000)
	writeFile(t, filepath.Join(primary, ".users", "u1", "up.mp3"), 7)
	external := filepath.Join(dir, "external")
	writeFile(t, filepath.Join(external, "x.flac"), 3)
	if err := os.Symlink(filepath.Join(artist, "album", "01.flac"), filepath.Join(external, "link.flac")); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(dir, "gone")

	// The nested root comes first, so skipping it relies on containment, not
	// order.
	roots := []string{artist, primary, external, missing, primary + "/"}
	got, err := MeasureUsage(context.Background(), roots)
	if err != nil {
		t.Fatal(err)
	}
	want := []Usage{
		{Path: artist, Files: 2, Bytes: 105},
		{Path: primary, Files: 5, Bytes: 1122},
		{Path: external, Files: 1, Bytes: 3},
		{Path: missing},
		{Path: primary + "/", Files: 5, Bytes: 1122},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d results, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("root %d: got %+v, want %+v", i, got[i], want[i])
		}
	}
}

// A nested root behind a symlink isn't reached by the outer walk (walks
// don't follow symlinks), so it needs its own.
func TestMeasureUsageNestedBehindSymlink(t *testing.T) {
	dir := t.TempDir()
	music := filepath.Join(dir, "music")
	writeFile(t, filepath.Join(music, "a.flac"), 10)
	writeFile(t, filepath.Join(dir, "real", "artist", "b.flac"), 200)
	if err := os.Symlink(filepath.Join(dir, "real"), filepath.Join(music, "link")); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(music, "link", "artist")
	got, err := MeasureUsage(context.Background(), []string{music, nested})
	if err != nil {
		t.Fatal(err)
	}
	if got[0].Files != 1 || got[0].Bytes != 10 {
		t.Errorf("outer = %+v, want only its own file", got[0])
	}
	if got[1].Files != 1 || got[1].Bytes != 200 {
		t.Errorf("nested = %+v, want 1 file / 200 bytes", got[1])
	}
}

func TestReaches(t *testing.T) {
	dir := t.TempDir()
	for _, d := range []string{"m/a/b", "m/.hidden/c", "other"} {
		if err := os.MkdirAll(filepath.Join(dir, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(dir, "other"), filepath.Join(dir, "m", "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dir, "m"), filepath.Join(dir, "mlink")); err != nil {
		t.Fatal(err)
	}
	// Walks don't enter a symlink given as their root, so nothing is reached
	// through one (except the root itself).
	if Reaches(filepath.Join(dir, "mlink"), filepath.Join(dir, "mlink", "a"), false) {
		t.Error("Reaches(mlink, mlink/a) = true, want false: the outer root is a symlink")
	}
	m := filepath.Join(dir, "m")
	// Searchable but not readable: Lstat below it works, a walk can't list it.
	if os.Geteuid() != 0 {
		locked := filepath.Join(dir, "locked")
		if err := os.MkdirAll(filepath.Join(locked, "in"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(locked, 0o111); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })
		if Reaches(locked, filepath.Join(locked, "in"), false) {
			t.Error("Reaches through an unreadable directory = true, want false")
		}
	}
	for _, tc := range []struct {
		inner   string
		skipDot bool
		want    bool
	}{
		{"m", true, true},
		{"m/a/b", true, true},
		{"m/.hidden/c", false, true},
		{"m/.hidden/c", true, false},
		{"m/link", false, false},
		{"m/missing", false, false},
		{"other", false, false},
	} {
		if got := Reaches(m, filepath.Join(dir, tc.inner), tc.skipDot); got != tc.want {
			t.Errorf("Reaches(m, %s, skipDot=%v) = %v, want %v", tc.inner, tc.skipDot, got, tc.want)
		}
	}
}

func TestMeasureUsageCancelled(t *testing.T) {
	dir := t.TempDir()
	// The walk checks ctx every 1024 entries.
	for i := range 2048 {
		writeFile(t, filepath.Join(dir, fmt.Sprintf("%04d.flac", i)), 1)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := MeasureUsage(ctx, []string{dir}); err == nil {
		t.Fatal("expected an error from a cancelled walk")
	}
}

func TestUsageCache(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "a.flac"), 10)
	var c UsageCache
	ctx := context.Background()

	first, at, err := c.Get(ctx, []string{dir}, false)
	if err != nil || first[0].Files != 1 {
		t.Fatalf("first = %+v, %v", first, err)
	}

	writeFile(t, filepath.Join(dir, "b.flac"), 10)
	cached, cachedAt, err := c.Get(ctx, []string{dir}, false)
	if err != nil || cached[0].Files != 1 || !cachedAt.Equal(at) {
		t.Fatalf("cached = %+v at %v, %v; want the first result", cached, cachedAt, err)
	}

	fresh, _, err := c.Get(ctx, []string{dir}, true)
	if err != nil || fresh[0].Files != 2 {
		t.Fatalf("fresh = %+v, %v; want 2 files", fresh, err)
	}

	// A different root set is measured, not served from the cache.
	other := t.TempDir()
	got, _, err := c.Get(ctx, []string{dir, other}, false)
	if err != nil || len(got) != 2 || got[0].Files != 2 || got[1].Files != 0 {
		t.Fatalf("new roots = %+v, %v", got, err)
	}
}

// A forced refresh must not join a walk that started before it: that walk may
// have read the disk before whatever the refresh is meant to pick up.
func TestUsageCacheFreshSupersedesInFlightWalk(t *testing.T) {
	release := make(chan struct{})
	started := make(chan int, 2)
	calls := 0
	c := UsageCache{walk: func(ctx context.Context, roots []string) ([]Usage, error) {
		calls++
		n := calls
		started <- n
		if n == 1 {
			<-release
		}
		return []Usage{{Path: roots[0], Files: int64(n)}}, nil
	}}
	ctx := context.Background()
	roots := []string{"/music"}

	first := make(chan []Usage)
	go func() {
		got, _, _ := c.Get(ctx, roots, false)
		first <- got
	}()
	<-started // the first walk is under way and blocked

	fresh, _, err := c.Get(ctx, roots, true)
	if err != nil || fresh[0].Files != 2 {
		t.Fatalf("fresh = %+v, %v; want the second walk", fresh, err)
	}
	close(release)
	if got := <-first; got[0].Files != 1 {
		t.Fatalf("first caller got %+v, want its own walk", got)
	}
	// The older walk finished last but must not replace the newer result.
	cached, _, err := c.Get(ctx, roots, false)
	if err != nil || cached[0].Files != 2 {
		t.Fatalf("cached = %+v, %v; want the fresh result", cached, err)
	}
}
