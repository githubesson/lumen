package ingest

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestFixInvalidUTF8PathRenamesFile(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "yunglean", "Deleted")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	bad := filepath.Join(dir, "ICE Cubes - S\xf6der.wav")
	if err := os.WriteFile(bad, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := &Service{MusicRoot: root}
	got := s.fixInvalidUTF8Path(context.Background(), bad)

	want := filepath.Join(dir, "ICE Cubes - Sder.wav")
	if got != want {
		t.Fatalf("fixed path = %q, want %q", got, want)
	}
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("renamed file missing: %v", err)
	}
}

func TestFixInvalidUTF8PathRenamesDirectoryAndFile(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "artist", "Alb\xfem")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	bad := filepath.Join(dir, "S\xf6ng.mp3")
	if err := os.WriteFile(bad, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := &Service{MusicRoot: root}
	got := s.fixInvalidUTF8Path(context.Background(), bad)

	want := filepath.Join(root, "artist", "Albm", "Sng.mp3")
	if got != want {
		t.Fatalf("fixed path = %q, want %q", got, want)
	}
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("renamed file missing: %v", err)
	}
}

func TestFixInvalidUTF8PathAvoidsCollision(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "Sder.wav"), []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	bad := filepath.Join(root, "S\xf6der.wav")
	if err := os.WriteFile(bad, []byte("b"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := &Service{MusicRoot: root}
	got := s.fixInvalidUTF8Path(context.Background(), bad)

	want := filepath.Join(root, "Sder (1).wav")
	if got != want {
		t.Fatalf("fixed path = %q, want %q", got, want)
	}
	if b, err := os.ReadFile(want); err != nil || string(b) != "b" {
		t.Fatalf("renamed file content = %q, err %v", b, err)
	}
	if b, err := os.ReadFile(filepath.Join(root, "Sder.wav")); err != nil || string(b) != "a" {
		t.Fatalf("existing file clobbered: %q, err %v", b, err)
	}
}

func TestRenameInvalidRefusesExhaustedNames(t *testing.T) {
	root := t.TempDir()
	existing := make(map[string]string)
	for i := 0; i <= 99; i++ {
		name := "Sder.wav"
		if i > 0 {
			name = fmt.Sprintf("Sder (%d).wav", i)
		}
		path := filepath.Join(root, name)
		existing[path] = fmt.Sprintf("original audio %d", i)
		if err := os.WriteFile(path, []byte(existing[path]), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	name := "S\xf6der.wav"
	from := filepath.Join(root, name)
	existing[from] = "new audio"
	if err := os.WriteFile(from, []byte(existing[from]), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &Service{MusicRoot: root}
	if _, err := s.renameInvalid(context.Background(), from, root, name); !errors.Is(err, os.ErrExist) {
		t.Fatalf("rename error = %v, want ErrExist", err)
	}
	for path, want := range existing {
		if got, err := os.ReadFile(path); err != nil || string(got) != want {
			t.Errorf("audio changed at %q: got %q, error %v", path, got, err)
		}
	}
}

func TestSanitizeTreeFixesWholeTreeInOnePass(t *testing.T) {
	if runtime.GOOS == "windows" {
		// NTFS stores names as UTF-16: invalid bytes are converted to U+FFFD
		// at creation, so ReadDir can never return an invalid name here. The
		// backend runs on Linux, where raw bytes survive the round trip.
		t.Skip("invalid UTF-8 file names cannot exist on Windows")
	}
	root := t.TempDir()
	dir := filepath.Join(root, "artist", "Alb\xfem")
	nested := filepath.Join(dir, "D\xe9luxe")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	// Multiple siblings inside the invalid dir — the case a mid-walk rename
	// would strand until the next rescan.
	for _, name := range []string{"S\xf6ng.mp3", "track two.mp3", "S\xf6ng2.mp3"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(nested, "b\xf5nus.mp3"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := &Service{MusicRoot: root}
	s.sanitizeTree(context.Background(), root)

	for _, want := range []string{
		filepath.Join(root, "artist", "Albm", "Sng.mp3"),
		filepath.Join(root, "artist", "Albm", "track two.mp3"),
		filepath.Join(root, "artist", "Albm", "Sng2.mp3"),
		filepath.Join(root, "artist", "Albm", "Dluxe", "bnus.mp3"),
	} {
		if _, err := os.Stat(want); err != nil {
			t.Errorf("expected %q after sanitize: %v", want, err)
		}
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("old invalid dir still present (err=%v)", err)
	}
}

func TestFixInvalidUTF8PathLeavesValidPathsAlone(t *testing.T) {
	s := &Service{MusicRoot: "/mnt/music"}
	p := filepath.Join("/mnt/music", "artist", "Söder.wav")
	if got := s.fixInvalidUTF8Path(context.Background(), p); got != p {
		t.Fatalf("valid path changed: %q", got)
	}
}
