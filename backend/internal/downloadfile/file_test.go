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

func TestSaveRejectsOversizedBodyWithoutLeavingFiles(t *testing.T) {
	prev := MaxFileBytes
	MaxFileBytes = 8
	defer func() { MaxFileBytes = prev }()

	dir := t.TempDir()
	target := filepath.Join(dir, "huge.mp3")
	if _, _, err := Save(strings.NewReader("0123456789"), target); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("Save err = %v, want ErrTooLarge", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("oversized download left files behind: %v", entries)
	}

	if _, _, err := Save(strings.NewReader("01234567"), target); err != nil {
		t.Fatalf("Save at limit: %v", err)
	}
}

func TestSaveNewNeverReusesExistingFile(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "song.flac")
	if err := os.WriteFile(target, []byte("other release"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := SaveNew(strings.NewReader("this release"), target)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(dir, "song-1.flac"); got != want {
		t.Fatalf("saved to %q, want %q", got, want)
	}
	for path, want := range map[string]string{target: "other release", got: "this release"} {
		if b, err := os.ReadFile(path); err != nil || string(b) != want {
			t.Fatalf("%s = %q, %v; want %q", path, b, err, want)
		}
	}
}

func TestSkipFinal(t *testing.T) {
	// Ingest reads .flac, say, but not .txt.
	supported := func(name string) bool { return filepath.Ext(name) == ".flac" }
	for reason, want := range map[string]bool{
		SkippedHost:                              true,
		UnsupportedExtension("notes.txt").Reason: true,
		// Ingest has learned the format since.
		UnsupportedExtension("song.flac").Reason: false,
		// A page served without a file name, say: the next response may have one.
		UnsupportedExtension("README").Reason: false,
		// Our policy, which can be relaxed.
		"download URL host is not allowed": false,
		// Our disk, not the link.
		destinationError(os.ErrPermission).Error(): false,
		// Recorded before the reason named the extension, possibly for a name
		// cut short.
		"unsupported file extension":      false,
		`unsupported file extension "`:    false,
		`unsupported file extension ".x`:  false,
		`unsupported file extension ""`:   false,
		`unsupported file extension .txt`: false,
	} {
		if got := SkipFinal(reason, supported); got != want {
			t.Errorf("SkipFinal(%q) = %v, want %v", reason, got, want)
		}
	}
	if got := UnsupportedExtension("notes.txt").Reason; got != `unsupported file extension ".txt"` {
		t.Errorf("reason = %q", got)
	}
}
