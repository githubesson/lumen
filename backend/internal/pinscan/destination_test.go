package pinscan

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/db"
	"github.com/githubesson/lumen/internal/musicroots"
	"github.com/githubesson/lumen/internal/testdb"
)

func TestResolveDestination(t *testing.T) {
	root := t.TempDir()
	for _, tc := range []struct {
		subdir string
		want   string
		ok     bool
	}{
		{"", root, true},
		{".", root, true},
		{"TIDAL", filepath.Join(root, "TIDAL"), true},
		{"a/../b", filepath.Join(root, "b"), true},
		{"../escape", "", false},
		{"/abs", "", false},
	} {
		got, err := ResolveDestination(root, tc.subdir)
		if tc.ok != (err == nil) || got != tc.want {
			t.Errorf("ResolveDestination(%q) = %q, %v; want %q, ok=%v", tc.subdir, got, err, tc.want, tc.ok)
		}
	}
	if _, err := ResolveDestination(" ", "TIDAL"); err == nil {
		t.Error("accepted a blank root")
	}
	unmounted := filepath.Join(root, "unmounted")
	if _, err := ResolveDestination(unmounted, "TIDAL"); err == nil || !strings.Contains(err.Error(), "not available") {
		t.Errorf("accepted a root that does not exist: %v", err)
	}
	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveDestination(file, ""); err == nil {
		t.Error("accepted a root that is a file")
	}
	if _, err := os.Stat(unmounted); !os.IsNotExist(err) {
		t.Errorf("resolving recreated the missing root: %v", err)
	}
}

func TestDestinationWithoutRootIDUsesRootPath(t *testing.T) {
	root := t.TempDir()
	got, err := Destination(context.Background(), nil, nil, root, "Leaks")
	if err != nil || got != filepath.Join(root, "Leaks") {
		t.Fatalf("Destination = %q, %v", got, err)
	}
	if _, err := Destination(context.Background(), nil, nil, filepath.Join(root, "gone"), ""); err == nil {
		t.Fatal("accepted a missing primary root")
	}
	id := uuid.New()
	if _, err := Destination(context.Background(), nil, &id, root, ""); err == nil {
		t.Fatal("resolved a registered root without the roots store")
	}
}

func TestDestinationChecksRegisteredRoot(t *testing.T) {
	base := os.Getenv("LUMEN_REVIEW_TEST_DATABASE_URL")
	if base == "" {
		t.Skip("set LUMEN_REVIEW_TEST_DATABASE_URL to an isolated PostgreSQL database")
	}
	ctx := context.Background()
	// Own database: an extra enabled root would show up in other packages'
	// scans while this test runs.
	dsn, err := testdb.Sibling(ctx, base, "_pinscan")
	if err != nil {
		t.Logf("using the shared test database: %v", err)
		dsn = base
	}
	if err := db.Migrate(dsn); err != nil {
		t.Fatal(err)
	}
	pool, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	roots := musicroots.NewStore(pool)
	dir := t.TempDir()
	root, err := roots.Add(ctx, dir, "extra")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { roots.Delete(context.Background(), root.ID) })

	// The registered root's path wins over the stored one.
	got, err := Destination(ctx, roots, &root.ID, "/stale/path", "Leaks")
	if err != nil || got != filepath.Join(dir, "Leaks") {
		t.Fatalf("enabled root: %q, %v", got, err)
	}
	if _, err := roots.SetEnabled(ctx, root.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := Destination(ctx, roots, &root.ID, dir, "Leaks"); err == nil || !strings.Contains(err.Error(), "disabled") {
		t.Fatalf("disabled root accepted: %v", err)
	}
	if _, err := roots.SetEnabled(ctx, root.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := Destination(ctx, roots, &root.ID, dir, "Leaks"); err == nil || !strings.Contains(err.Error(), "not available") {
		t.Fatalf("unmounted root accepted: %v", err)
	}
	missing := uuid.New()
	if _, err := Destination(ctx, roots, &missing, dir, ""); err == nil {
		t.Fatal("accepted an unknown root id")
	}
}
