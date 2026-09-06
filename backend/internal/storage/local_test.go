package storage

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalPutAtomicallyReplacesObject(t *testing.T) {
	root := t.TempDir()
	store := NewLocal(root)
	ctx := context.Background()

	if _, err := store.Put(ctx, "covers/album.jpg", strings.NewReader("old"), 3, "image/jpeg"); err != nil {
		t.Fatalf("seed object: %v", err)
	}
	info, err := store.Put(ctx, "covers/album.jpg", strings.NewReader("new value"), 9, "image/webp")
	if err != nil {
		t.Fatalf("replace object: %v", err)
	}
	if info.Size != 9 || info.ContentType != "image/webp" {
		t.Fatalf("Put info = %+v", info)
	}
	assertFileContent(t, filepath.Join(root, "covers", "album.jpg"), "new value")
	assertNoTemporaryFiles(t, filepath.Join(root, "covers"))
}

func TestLocalPutFailurePreservesExistingObject(t *testing.T) {
	root := t.TempDir()
	store := NewLocal(root)
	ctx := context.Background()
	key := "covers/album.jpg"

	if _, err := store.Put(ctx, key, strings.NewReader("original"), 8, "image/jpeg"); err != nil {
		t.Fatalf("seed object: %v", err)
	}
	writeErr := errors.New("source failed")
	_, err := store.Put(ctx, key, &errorAfterReader{data: []byte("partial"), err: writeErr}, -1, "image/jpeg")
	if !errors.Is(err, writeErr) {
		t.Fatalf("Put error = %v, want %v", err, writeErr)
	}
	assertFileContent(t, filepath.Join(root, "covers", "album.jpg"), "original")
	assertNoTemporaryFiles(t, filepath.Join(root, "covers"))
}

func TestLocalPutCancellationPreservesExistingObject(t *testing.T) {
	root := t.TempDir()
	store := NewLocal(root)
	key := "audio/track.flac"
	if _, err := store.Put(context.Background(), key, strings.NewReader("original"), 8, "audio/flac"); err != nil {
		t.Fatalf("seed object: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	_, err := store.Put(ctx, key, &cancelAfterReader{cancel: cancel, data: []byte("partial")}, -1, "audio/flac")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Put error = %v, want context.Canceled", err)
	}
	assertFileContent(t, filepath.Join(root, "audio", "track.flac"), "original")
	assertNoTemporaryFiles(t, filepath.Join(root, "audio"))
}

type errorAfterReader struct {
	data []byte
	err  error
	done bool
}

func (r *errorAfterReader) Read(p []byte) (int, error) {
	if r.done {
		return 0, r.err
	}
	r.done = true
	return copy(p, r.data), nil
}

type cancelAfterReader struct {
	cancel context.CancelFunc
	data   []byte
	done   bool
}

func (r *cancelAfterReader) Read(p []byte) (int, error) {
	if r.done {
		return 0, io.EOF
	}
	r.done = true
	n := copy(p, r.data)
	r.cancel()
	return n, nil
}

func assertFileContent(t *testing.T, path, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if string(got) != want {
		t.Fatalf("content = %q, want %q", got, want)
	}
}

func assertNoTemporaryFiles(t *testing.T, dir string) {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(dir, ".*.tmp-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 0 {
		t.Fatalf("temporary files left behind: %v", matches)
	}
}
