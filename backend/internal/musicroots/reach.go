package musicroots

import (
	"os"
	"path/filepath"
	"strings"
)

// Reaches reports whether a walk of outer that doesn't follow symlinks gets to
// inner: inner is at or below outer, and every step down to it, inner
// included, is a real directory rather than a symlink. With skipDotDirs the
// way down must also avoid dot-directories, which the scanner and watcher
// leave out. Being inside outer by path alone isn't enough: files past a
// symlink or a dot-directory are never scanned from outer.
func Reaches(outer, inner string, skipDotDirs bool) bool {
	outerAbs, err := filepath.Abs(outer)
	if err != nil {
		return false
	}
	innerAbs, err := filepath.Abs(inner)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(outerAbs, innerAbs)
	if err != nil || filepath.IsAbs(rel) || rel == ".." ||
		strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	if rel == "." {
		return true
	}
	cur := outerAbs
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		if skipDotDirs && strings.HasPrefix(part, ".") {
			return false
		}
		cur = filepath.Join(cur, part)
		// Lstat, so a symlink reports as one rather than as its target.
		info, err := os.Lstat(cur)
		if err != nil || !info.IsDir() {
			return false
		}
	}
	return true
}
