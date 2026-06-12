package storage

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/uncut/lumen/internal/pathsafe"
)

type Local struct {
	Root string
}

func NewLocal(root string) *Local { return &Local{Root: root} }

func (l *Local) resolve(key string) (string, error) {
	// Treat the key as rooted: drop any leading slash and clean it so "../"
	// segments collapse before it is joined onto the storage root.
	clean := filepath.Clean("/" + strings.TrimPrefix(key, "/"))
	full := filepath.Join(l.Root, clean)
	absFull, err := filepath.Abs(full)
	if err != nil {
		return "", err
	}
	ok, err := pathsafe.WithinRoot(l.Root, absFull)
	if err != nil || !ok {
		return "", errors.New("path escapes storage root")
	}
	return absFull, nil
}

func (l *Local) Put(ctx context.Context, key string, r io.Reader, _ int64, contentType string) (ObjectInfo, error) {
	p, err := l.resolve(key)
	if err != nil {
		return ObjectInfo{}, err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return ObjectInfo{}, err
	}
	f, err := os.Create(p)
	if err != nil {
		return ObjectInfo{}, err
	}
	defer f.Close()
	n, err := io.Copy(f, r)
	if err != nil {
		return ObjectInfo{}, err
	}
	return ObjectInfo{Key: key, Size: n, ContentType: contentType}, nil
}

func (l *Local) Get(ctx context.Context, key string) (io.ReadSeekCloser, ObjectInfo, error) {
	p, err := l.resolve(key)
	if err != nil {
		return nil, ObjectInfo{}, err
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, ObjectInfo{}, err
	}
	stat, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, ObjectInfo{}, err
	}
	return f, ObjectInfo{Key: key, Size: stat.Size()}, nil
}

func (l *Local) Stat(ctx context.Context, key string) (ObjectInfo, error) {
	p, err := l.resolve(key)
	if err != nil {
		return ObjectInfo{}, err
	}
	stat, err := os.Stat(p)
	if err != nil {
		return ObjectInfo{}, err
	}
	return ObjectInfo{Key: key, Size: stat.Size()}, nil
}

func (l *Local) Delete(ctx context.Context, key string) error {
	p, err := l.resolve(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (l *Local) Exists(ctx context.Context, key string) (bool, error) {
	_, err := l.Stat(ctx, key)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, err
}
