// Package storage defines the backend-agnostic interface for persisting and
// reading audio files and cover art. A local-filesystem implementation lives
// in this package; an S3-compatible implementation can be added later without
// touching callers.
package storage

import (
	"context"
	"io"
)

type ObjectInfo struct {
	Key         string
	Size        int64
	ContentType string
}

type Storage interface {
	// Put writes an object. size may be -1 if unknown.
	Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) (ObjectInfo, error)
	// Get returns a ReadSeekCloser so HTTP range requests can be served directly.
	Get(ctx context.Context, key string) (io.ReadSeekCloser, ObjectInfo, error)
	// Stat returns metadata without opening the body.
	Stat(ctx context.Context, key string) (ObjectInfo, error)
	// Delete removes an object. Missing keys are not an error.
	Delete(ctx context.Context, key string) error
	// Exists is a convenience on top of Stat.
	Exists(ctx context.Context, key string) (bool, error)
}
