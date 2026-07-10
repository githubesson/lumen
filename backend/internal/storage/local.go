package storage

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/githubesson/lumen/internal/pathsafe"
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
	if err := ctx.Err(); err != nil {
		return ObjectInfo{}, err
	}
	p, err := l.resolve(key)
	if err != nil {
		return ObjectInfo{}, err
	}
	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return ObjectInfo{}, err
	}

	// Write beside the destination and rename only after the complete object is
	// ready. A failed or canceled Put therefore never exposes a truncated
	// object and leaves an existing value untouched.
	f, err := os.CreateTemp(dir, "."+filepath.Base(p)+".tmp-*")
	if err != nil {
		return ObjectInfo{}, err
	}
	tmp := f.Name()
	committed := false
	defer func() {
		_ = f.Close()
		if !committed {
			_ = os.Remove(tmp)
		}
	}()

	if err := f.Chmod(0o644); err != nil {
		return ObjectInfo{}, err
	}
	n, err := io.Copy(f, &contextReader{ctx: ctx, r: r})
	if err != nil {
		return ObjectInfo{}, err
	}
	if err := ctx.Err(); err != nil {
		return ObjectInfo{}, err
	}
	if err := f.Sync(); err != nil {
		return ObjectInfo{}, err
	}
	if err := f.Close(); err != nil {
		return ObjectInfo{}, err
	}
	if err := ctx.Err(); err != nil {
		return ObjectInfo{}, err
	}
	if err := os.Rename(tmp, p); err != nil {
		return ObjectInfo{}, err
	}
	committed = true
	return ObjectInfo{Key: key, Size: n, ContentType: contentType}, nil
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
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
