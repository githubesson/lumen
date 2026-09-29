package musicroots

import (
	"os"
	"path/filepath"
	"strings"
)

// Reaches reports whether a walk of outer that doesn't follow symlinks gets to
// inner: inner is at or below outer, outer and every step down to inner are
// real directories rather than symlinks, and each one above inner can be
// listed (a walk can't enter a directory it may not read). With skipDotDirs the
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
	// A walk given a symlink as its root doesn't enter it either.
	if info, err := os.Lstat(outerAbs); err != nil || !info.IsDir() {
		return false
	}
	cur := outerAbs
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		if skipDotDirs && strings.HasPrefix(part, ".") {
			return false
		}
		if !listable(cur) {
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

// listable reports whether dir can be opened for reading, which a walk needs
// to see what's inside it. Search permission alone lets Lstat through.
func listable(dir string) bool {
	f, err := os.Open(dir)
	if err != nil {
		return false
	}
	f.Close()
	return true
}
