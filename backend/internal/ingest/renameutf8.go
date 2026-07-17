package ingest

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/githubesson/lumen/internal/dbtext"
)

// fixInvalidUTF8Path renames any path segments PostgreSQL cannot store
// (invalid UTF-8 or NUL bytes), stripping the offending bytes, and returns
// the resulting path. Only segments below the containing music root are
// renamed; when no configured root matches, only the file name itself is
// touched. On any rename failure the remaining path is returned as-is so
// ingest surfaces the usual error.
func (s *Service) fixInvalidUTF8Path(ctx context.Context, path string) string {
	if dbtext.Valid(path) {
		return path
	}
	sep := string(filepath.Separator)
	base := ""
	for _, root := range s.AllRoots(ctx) {
		root = strings.TrimRight(root, sep)
		if root != "" && strings.HasPrefix(path, root+sep) && len(root) > len(base) {
			base = root
		}
	}
	if base == "" {
		base = filepath.Dir(path)
	}
	cur := base
	segs := strings.Split(strings.TrimPrefix(path, base+sep), sep)
	for i, seg := range segs {
		from := filepath.Join(cur, seg)
		if dbtext.Valid(seg) {
			cur = from
			continue
		}
		to, err := s.renameInvalid(ctx, from, cur, seg)
		if err != nil {
			return filepath.Join(append([]string{cur}, segs[i:]...)...)
		}
		cur = to
	}
	return cur
}

// renameInvalid renames the entry at from (directory dir, base name name) to
// its cleaned, collision-free variant and clears any stale ingest_errors row
// recorded under the old path.
func (s *Service) renameInvalid(ctx context.Context, from, dir, name string) (string, error) {
	to := uniquePath(filepath.Join(dir, cleanPathSegment(name)))
	if err := os.Rename(from, to); err != nil {
		s.log().Warn("rename of non-UTF-8 path failed",
			"path", dbtext.Clean(from), "err", err)
		return "", err
	}
	s.log().Info("renamed non-UTF-8 path",
		"from", dbtext.Clean(from), "to", to)
	if s.Library != nil {
		s.Library.ClearIngestErrorsForPath(ctx, from)
	}
	return to, nil
}

// sanitizeTree renames every file and directory under root whose name is not
// storable as PostgreSQL text (invalid UTF-8 or NUL bytes). Run before the
// ingest walk enumerates the tree: when a directory is renamed, the walk
// continues inside the renamed directory immediately, so its contents are
// ingested in the same rescan pass instead of the next one.
func (s *Service) sanitizeTree(ctx context.Context, root string) {
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if path == root {
			return nil
		}
		if d.IsDir() && strings.HasPrefix(d.Name(), ".") {
			return filepath.SkipDir
		}
		if dbtext.Valid(d.Name()) {
			return nil
		}
		to, rerr := s.renameInvalid(ctx, path, filepath.Dir(path), d.Name())
		if rerr != nil {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			// The walker would descend into the now-stale old path; walk the
			// renamed directory ourselves and skip the old one.
			s.sanitizeTree(ctx, to)
			return filepath.SkipDir
		}
		return nil
	})
}

// cleanPathSegment strips bytes PostgreSQL rejects from one path segment,
// falling back to "untitled" when nothing legible remains.
func cleanPathSegment(seg string) string {
	cleaned := strings.ReplaceAll(strings.ToValidUTF8(seg, ""), "\x00", "")
	cleaned = strings.TrimSpace(cleaned)
	if cleaned == "" || cleaned == "." || cleaned == ".." {
		return "untitled"
	}
	return cleaned
}

// uniquePath returns p, or the first "p (n)" variant (before the extension)
// that does not exist yet.
func uniquePath(p string) string {
	if _, err := os.Lstat(p); errors.Is(err, os.ErrNotExist) {
		return p
	}
	ext := filepath.Ext(p)
	stem := strings.TrimSuffix(p, ext)
	for i := 1; i <= 99; i++ {
		cand := fmt.Sprintf("%s (%d)%s", stem, i, ext)
		if _, err := os.Lstat(cand); errors.Is(err, os.ErrNotExist) {
			return cand
		}
	}
	return p
}
