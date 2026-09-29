package musicroots

import (
	"context"
	"io/fs"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Usage is the on-disk footprint of one music root: every regular file under
// it, counted the way `find -type f | wc -l` and `du -s --apparent-size` do.
// Symlinks are not followed, matching the scanner.
type Usage struct {
	Path  string `json:"path"`
	Files int64  `json:"files"`
	Bytes int64  `json:"bytes"`
}

// MeasureUsage totals each root. A root nested inside another
// (/mnt/music/<artist> under /mnt/music, a common layout) is not walked a
// second time: the outer walk credits every file to each root containing it.
// Missing or unreadable roots and entries count as empty; the only error is
// ctx ending mid-walk.
func MeasureUsage(ctx context.Context, roots []string) ([]Usage, error) {
	out := make([]Usage, len(roots))
	norm := make([]string, len(roots))
	for i, r := range roots {
		out[i].Path = r
		if abs, err := filepath.Abs(r); err == nil {
			norm[i] = abs
		} else {
			norm[i] = filepath.Clean(r)
		}
	}
	for i, root := range norm {
		if walkedElsewhere(i, norm) {
			continue
		}
		var covered []int
		for j, other := range norm {
			if within(other, root) {
				covered = append(covered, j)
			}
		}
		seen := 0
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if seen++; seen%1024 == 0 && ctx.Err() != nil {
				return ctx.Err()
			}
			if err != nil || !d.Type().IsRegular() {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			for _, j := range covered {
				if within(path, norm[j]) {
					out[j].Files++
					out[j].Bytes += info.Size()
				}
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

// walkedElsewhere reports whether root i is covered by another root's walk:
// it sits inside a different root, or repeats an earlier one.
func walkedElsewhere(i int, roots []string) bool {
	for j, other := range roots {
		if j == i || !within(roots[i], other) {
			continue
		}
		if roots[i] != other || j < i {
			return true
		}
	}
	return false
}

// within reports whether path is dir or somewhere below it.
func within(path, dir string) bool {
	if path == dir {
		return true
	}
	prefix := dir
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	return strings.HasPrefix(path, prefix)
}

const (
	usageTTL         = 5 * time.Minute
	usageWalkTimeout = 5 * time.Minute
)

// UsageCache keeps the last measurement so the admin page doesn't walk the
// whole library on every visit, and lets concurrent callers share one walk.
// The zero value is ready to use.
type UsageCache struct {
	mu     sync.Mutex
	key    string
	result []Usage
	at     time.Time
	flight *usageFlight
}

type usageFlight struct {
	key    string
	done   chan struct{}
	result []Usage
	at     time.Time
	err    error
}

// Get returns the usage of roots and when it was measured. A cached result
// for the same roots younger than the TTL is reused unless fresh is set. The
// walk itself runs detached from ctx, so a caller that gives up (a closed
// tab, a proxy timeout) still leaves a result behind for the next one.
func (c *UsageCache) Get(ctx context.Context, roots []string, fresh bool) ([]Usage, time.Time, error) {
	key := strings.Join(roots, "\x00")
	c.mu.Lock()
	if !fresh && c.result != nil && c.key == key && time.Since(c.at) < usageTTL {
		result, at := c.result, c.at
		c.mu.Unlock()
		return result, at, nil
	}
	f := c.flight
	if f == nil || f.key != key {
		f = &usageFlight{key: key, done: make(chan struct{})}
		c.flight = f
		go c.measure(f, append([]string(nil), roots...))
	}
	c.mu.Unlock()

	select {
	case <-f.done:
		return f.result, f.at, f.err
	case <-ctx.Done():
		return nil, time.Time{}, ctx.Err()
	}
}

func (c *UsageCache) measure(f *usageFlight, roots []string) {
	ctx, cancel := context.WithTimeout(context.Background(), usageWalkTimeout)
	defer cancel()
	f.result, f.err = MeasureUsage(ctx, roots)
	f.at = time.Now()

	c.mu.Lock()
	// A walk superseded by one for a different root set must not overwrite
	// the newer result.
	if c.flight == f {
		c.flight = nil
		if f.err == nil {
			c.key, c.result, c.at = f.key, f.result, f.at
		}
	}
	c.mu.Unlock()
	close(f.done)
}
