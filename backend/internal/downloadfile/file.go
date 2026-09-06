// Package downloadfile installs remote media while preserving existing files.
package downloadfile

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func nextAvailablePath(target string) string {
	if _, err := os.Stat(target); errors.Is(err, os.ErrNotExist) {
		return target
	}
	ext := filepath.Ext(target)
	base := strings.TrimSuffix(target, ext)
	for i := 1; i < 10000; i++ {
		cand := fmt.Sprintf("%s-%d%s", base, i, ext)
		if _, err := os.Stat(cand); errors.Is(err, os.ErrNotExist) {
			return cand
		}
	}
	return fmt.Sprintf("%s-%d%s", base, time.Now().UnixNano(), ext)
}

func NonEmpty(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir() && info.Size() > 0
}

func pathExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func isReadOnlyDestinationError(err error) bool {
	if err == nil {
		return false
	}
	if os.IsPermission(err) {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "read-only file system")
}

func InstallNoOverwrite(tmpPath, target string) (string, error) {
	for i := 0; i < 10000; i++ {
		if err := os.Link(tmpPath, target); err == nil {
			_ = os.Remove(tmpPath)
			return target, nil
		} else if os.IsExist(err) {
			target = nextAvailablePath(target)
			continue
		}

		// Some filesystems disallow hard links. Fall back to an O_EXCL copy,
		// preserving the same no-overwrite guarantee.
		out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if os.IsExist(err) {
			target = nextAvailablePath(target)
			continue
		}
		if err != nil {
			return target, err
		}
		in, err := os.Open(tmpPath)
		if err != nil {
			out.Close()
			_ = os.Remove(target)
			return target, err
		}
		_, copyErr := io.Copy(out, in)
		closeErr := out.Close()
		in.Close()
		if copyErr != nil {
			_ = os.Remove(target)
			return target, copyErr
		}
		if closeErr != nil {
			_ = os.Remove(target)
			return target, closeErr
		}
		_ = os.Remove(tmpPath)
		return target, nil
	}
	return target, fmt.Errorf("could not find an available target path")
}

// SkipError marks an input or destination that should be recorded as skipped.
type SkipError struct{ Reason string }

func (e SkipError) Error() string { return e.Reason }

// Save installs a downloaded body without overwriting another file. Existing
// non-empty files are reused; empty targets are preserved under their name.
// The returned path is also meaningful on failure for download history.
func Save(body io.Reader, target string) (filePath string, existing bool, err error) {
	if NonEmpty(target) {
		return target, true, nil
	}
	if pathExists(target) {
		target = nextAvailablePath(target)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return target, false, destinationError(err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), "."+filepath.Base(target)+".*.part")
	if err != nil {
		return target, false, destinationError(err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := io.Copy(tmp, body); err != nil {
		tmp.Close()
		return target, false, err
	}
	if err := tmp.Close(); err != nil {
		return target, false, err
	}
	if pathExists(target) {
		if NonEmpty(target) {
			return target, true, nil
		}
		target = nextAvailablePath(target)
	}
	target, err = InstallNoOverwrite(tmpPath, target)
	return target, false, err
}

func destinationError(err error) error {
	if isReadOnlyDestinationError(err) {
		return SkipError{Reason: "destination is read-only"}
	}
	return err
}
