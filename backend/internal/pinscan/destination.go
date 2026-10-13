package pinscan

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/musicroots"
	"github.com/githubesson/lumen/internal/pathsafe"
)

// Destination resolves the directory a pinned source (or TIDAL
// auto-download) writes under: subdir inside its music root. A registered
// root (rootID set) is looked up and must be enabled; a nil rootID means
// rootPath, the primary root.
func Destination(ctx context.Context, roots *musicroots.Store, rootID *uuid.UUID, rootPath, subdir string) (string, error) {
	if rootID != nil {
		if roots == nil {
			return "", errors.New("music roots are not available")
		}
		r, err := roots.Get(ctx, *rootID)
		if err != nil {
			return "", fmt.Errorf("destination root: %w", err)
		}
		// Playback only serves files under enabled roots, so whatever was
		// saved here would 403.
		if !r.Enabled {
			return "", fmt.Errorf("destination music root %s is disabled", r.Path)
		}
		rootPath = r.Path
	}
	return ResolveDestination(rootPath, subdir)
}

// ResolveDestination joins a music root and a relative subdirectory,
// refusing a root that isn't there and any subdirectory that escapes it.
func ResolveDestination(root, subdir string) (string, error) {
	if strings.TrimSpace(root) == "" {
		return "", errors.New("no music root configured")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	// An absent root is usually an unmounted volume. Creating the subfolder
	// would recreate the mount point and write onto the wrong filesystem.
	if info, err := os.Stat(abs); err != nil || !info.IsDir() {
		return "", fmt.Errorf("music root %s is not available", abs)
	}
	subdir = strings.TrimSpace(subdir)
	if subdir == "" || filepath.Clean(subdir) == "." {
		return abs, nil
	}
	if filepath.IsAbs(subdir) {
		return "", errors.New("destination subdir must be relative")
	}
	dest, err := pathsafe.CleanSubdir(abs, subdir)
	if err != nil {
		return "", errors.New("destination subdir escapes the music root")
	}
	return dest, nil
}
