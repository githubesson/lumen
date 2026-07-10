package handlers

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func TestCreateUniqueUploadConcurrent(t *testing.T) {
	dir := t.TempDir()
	const uploads = 24

	start := make(chan struct{})
	paths := make(chan string, uploads)
	errs := make(chan error, uploads)
	var wg sync.WaitGroup
	for i := 0; i < uploads; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			path, f, err := createUniqueUpload(dir, "song.mp3")
			if err != nil {
				errs <- err
				return
			}
			marker := strconv.Itoa(i)
			if _, err := f.WriteString(marker); err != nil {
				_ = f.Close()
				errs <- err
				return
			}
			if err := f.Close(); err != nil {
				errs <- err
				return
			}
			paths <- path
		}()
	}
	close(start)
	wg.Wait()
	close(paths)
	close(errs)

	for err := range errs {
		t.Fatalf("concurrent allocation failed: %v", err)
	}
	seen := make(map[string]struct{}, uploads)
	for path := range paths {
		if _, exists := seen[path]; exists {
			t.Fatalf("destination allocated more than once: %s", path)
		}
		seen[path] = struct{}{}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read allocated file: %v", err)
		}
		if len(data) == 0 {
			t.Fatalf("allocated file %s was overwritten or left empty", path)
		}
	}
	if len(seen) != uploads {
		t.Fatalf("allocated %d unique paths, want %d", len(seen), uploads)
	}
}

func TestWriteUniqueUploadRemovesPartialFile(t *testing.T) {
	dir := t.TempDir()
	_, _, err := writeUniqueUpload(context.Background(), dir, "large.mp3", strings.NewReader("12345"), 4)
	if !errors.Is(err, errFileTooLarge) {
		t.Fatalf("writeUniqueUpload error = %v, want errFileTooLarge", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("failed upload left files behind: %v", entryNames(entries))
	}
}

func TestWriteUniqueUploadHonorsCanceledContext(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, err := writeUniqueUpload(ctx, dir, "song.mp3", strings.NewReader("audio"), 100)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("writeUniqueUpload error = %v, want context.Canceled", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "song.mp3")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("canceled upload created a destination: %v", err)
	}
}

func entryNames(entries []os.DirEntry) []string {
	names := make([]string, len(entries))
	for i, entry := range entries {
		names[i] = entry.Name()
	}
	return names
}
