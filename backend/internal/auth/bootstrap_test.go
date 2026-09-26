package auth

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWritePasswordFileReplacesRegularFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pw")
	if err := os.WriteFile(path, []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writePasswordFile(path, "admin", "s3cret"); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "password: s3cret\n") || strings.Contains(string(b), "stale") {
		t.Fatalf("unexpected contents %q", b)
	}
}

// A symlink planted at the password path must not be followed.
func TestWritePasswordFileRefusesSymlink(t *testing.T) {
	dir := t.TempDir()
	victim := filepath.Join(dir, "victim")
	if err := os.WriteFile(victim, []byte("keep me"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "pw")
	if err := os.Symlink(victim, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := writePasswordFile(link, "admin", "s3cret"); err == nil {
		t.Fatal("wrote through a symlink")
	}
	if b, _ := os.ReadFile(victim); string(b) != "keep me" {
		t.Fatalf("symlink target overwritten: %q", b)
	}
}
