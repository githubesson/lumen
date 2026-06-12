// Package pathsafe centralizes filesystem path-containment checks used as a
// security boundary throughout the backend (download targets, ingest roots,
// storage keys, admin-configured subdirectories).
//
// All checks resolve paths to absolute form and compare with filepath.Rel
// rather than string prefixing: with root "/srv/music" a sibling directory
// like "/srv/music-archive/evil" would slip past a naive HasPrefix check but
// is correctly rejected here.
package pathsafe

import (
	"errors"
	"path/filepath"
	"strings"
)

// ErrEscapesRoot is returned when a target path resolves outside its root.
var ErrEscapesRoot = errors.New("path escapes root")

// contained reports whether absTarget is at or below absRoot. Both arguments
// must already be absolute. The relative path between them is rejected when it
// climbs out of root ("..", "../...") or is itself absolute (which happens on
// Windows when the two paths live on different volumes is reported via err, but
// an absolute rel is treated defensively as an escape).
func contained(absRoot, absTarget string) (bool, error) {
	rel, err := filepath.Rel(absRoot, absTarget)
	if err != nil {
		return false, err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return false, nil
	}
	return true, nil
}

// WithinRoot reports whether target resolves to root itself or a path beneath
// it. Both arguments are resolved to absolute paths first.
func WithinRoot(root, target string) (bool, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return false, err
	}
	absTarget, err := filepath.Abs(target)
	if err != nil {
		return false, err
	}
	return contained(absRoot, absTarget)
}

// WithinAnyRoot reports whether target is contained within any of roots.
// Roots that fail to resolve are skipped rather than treated as a match.
func WithinAnyRoot(roots []string, target string) bool {
	for _, root := range roots {
		if ok, err := WithinRoot(root, target); err == nil && ok {
			return true
		}
	}
	return false
}

// CleanSubdir joins a caller-supplied relative subdir onto root and guarantees
// the result stays within root. subdir must be relative; an absolute subdir is
// rejected. Returns the cleaned absolute path.
func CleanSubdir(root, subdir string) (string, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	if filepath.IsAbs(subdir) {
		return "", ErrEscapesRoot
	}
	dest := filepath.Join(absRoot, subdir)
	ok, err := contained(absRoot, dest)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", ErrEscapesRoot
	}
	return dest, nil
}
