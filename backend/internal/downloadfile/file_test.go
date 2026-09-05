package downloadfile

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/iotest"
)

func TestInstallNoOverwriteKeepsExistingFile(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "snippet.mov")
	tmp := filepath.Join(dir, ".snippet.mov.part")

	if err := os.WriteFile(target, []byte("existing"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tmp, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}

	written, err := InstallNoOverwrite(tmp, target)
	if err != nil {
		t.Fatal(err)
	}
	if written == target {
		t.Fatalf("expected alternate path, got original target")
	}
	gotExisting, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotExisting) != "existing" {
		t.Fatalf("existing target was replaced: %q", gotExisting)
	}
	gotNew, err := os.ReadFile(written)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotNew) != "new" {
		t.Fatalf("alternate target has wrong bytes: %q", gotNew)
	}
}

func TestIsReadOnlyDestinationError(t *testing.T) {
	if !isReadOnlyDestinationError(errors.New("open /music/file.part: read-only file system")) {
		t.Fatal("expected read-only filesystem error to be detected")
	}
	if isReadOnlyDestinationError(errors.New("network timeout")) {
		t.Fatal("unexpected read-only classification")
	}
}

func TestSaveReusesExistingAndPreservesEmptyTargets(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "track.mp3")
	if err := os.WriteFile(target, []byte("existing"), 0o644); err != nil {
		t.Fatal(err)
	}
	path, existing, err := Save(iotest.ErrReader(errors.New("must not read body")), target)
	if err != nil || !existing || path != target {
		t.Fatalf("did not reuse target: %q %v %v", path, existing, err)
	}
	if err := os.WriteFile(target, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	path, existing, err = Save(strings.NewReader("new"), target)
	if err != nil || existing || path == target {
		t.Fatalf("did not preserve empty target: %q %v %v", path, existing, err)
	}
	old, err := os.ReadFile(target)
	if err != nil || len(old) != 0 {
		t.Fatalf("empty target replaced: %q %v", old, err)
	}
	saved, err := os.ReadFile(path)
	if err != nil || string(saved) != "new" {
		t.Fatalf("bad saved bytes: %q %v", saved, err)
	}
}

func TestSaveCleansPartialDownloadOnReadError(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "track.mp3")
	want := errors.New("stream interrupted")
	_, _, err := Save(io.MultiReader(strings.NewReader("partial"), iotest.ErrReader(want)), target)
	if !errors.Is(err, want) {
		t.Fatalf("lost stream error: %v", err)
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 0 {
		t.Fatalf("failed download left files behind: %v", files)
	}
}
