package ingest

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"

	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/musicroots"
)

// RescanProgress is updated during a walk; callers can snapshot it for
// progress reporting.
type RescanProgress struct {
	Total     atomic.Int64
	Processed atomic.Int64
	Inserted  atomic.Int64
	Dedup     atomic.Int64
	Unchanged atomic.Int64
	Errored   atomic.Int64
	Pruned    atomic.Int64
	Done      atomic.Bool
	// Failure holds the error that aborted the scan, if any. Without it a scan
	// that died immediately (unreadable music root, say) was indistinguishable
	// from a completed empty one: status reported running:false with all-zero
	// counters and nothing was logged.
	Failure atomic.Pointer[string]
}

// FailureMessage returns the recorded abort reason, or "" if the scan did not
// fail.
func (p *RescanProgress) FailureMessage() string {
	if msg := p.Failure.Load(); msg != nil {
		return *msg
	}
	return ""
}

type RescanOptions struct {
	Force bool // re-read even files whose successful-ingest fingerprint matches
}

// Rescan walks the configured roots, skipping unchanged successful ingests,
// then reconciles the DB against disk. Force a full read with RescanWithOptions.
func (s *Service) Rescan(ctx context.Context, p *RescanProgress) error {
	return s.RescanWithOptions(ctx, p, RescanOptions{})
}

func (s *Service) RescanWithOptions(ctx context.Context, p *RescanProgress, options RescanOptions) error {
	defer p.Done.Store(true)
	roots := s.AllRoots(ctx)
	s.log().Info("rescan starting", "roots", roots)
	liveRoots := make([]string, 0, len(roots))
	for _, root := range roots {
		if _, err := os.Stat(root); err != nil {
			s.log().Warn("rescan root unavailable", "root", root, "err", err)
			continue
		}
		liveRoots = append(liveRoots, root)
	}
	var fingerprints map[string]library.IngestFingerprint
	if !options.Force && s.Library != nil {
		var err error
		fingerprints, err = s.Library.IngestFingerprints(ctx, liveRoots)
		if err != nil {
			return fmt.Errorf("load ingest fingerprints: %w", err)
		}
	}
	for _, root := range uniqueScanRoots(liveRoots) {
		before := p.Processed.Load()
		beforeInserted := p.Inserted.Load()
		if err := s.rescanRoot(ctx, root, p, fingerprints); err != nil {
			s.log().Warn("rescan root aborted", "root", root, "err", err)
			return err
		}
		s.log().Info("rescan root done",
			"root", root,
			"processed", p.Processed.Load()-before,
			"inserted", p.Inserted.Load()-beforeInserted,
		)
	}
	if err := s.pruneMissing(ctx, liveRoots, p); err != nil {
		s.log().Warn("prune missing failed", "err", err)
	}
	s.log().Info("rescan complete",
		"total", p.Total.Load(),
		"processed", p.Processed.Load(),
		"inserted", p.Inserted.Load(),
		"dedup", p.Dedup.Load(),
		"unchanged", p.Unchanged.Load(),
		"errored", p.Errored.Load(),
		"pruned", p.Pruned.Load(),
	)
	return nil
}

func (s *Service) rescanRoot(ctx context.Context, root string, p *RescanProgress, fingerprints map[string]library.IngestFingerprint) error {
	s.log().Info("rescan walking", "root", root)
	// Fix non-UTF-8 names before enumerating: renaming a directory during the
	// ingest walk would strand its already-listed children until the next
	// rescan, while a pre-pass keeps everything ingestable in this one.
	s.sanitizeTree(ctx, root)
	var supportedFound int64
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			s.log().Warn("rescan walk error", "root", root, "path", path, "err", err)
			return nil
		}
		if d.IsDir() {
			// Skip personal uploads and any other dotdirs.
			if path != root && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !IsSupported(path) {
			return nil
		}
		supportedFound++
		p.Total.Add(1)
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		abs, absErr := filepath.Abs(path)
		if fingerprint, ok := fingerprints[abs]; absErr == nil && ok {
			if info, err := d.Info(); err == nil && info.Mode().IsRegular() &&
				info.Size() == fingerprint.Size && info.ModTime().UnixNano() == fingerprint.MTimeNS {
				p.Processed.Add(1)
				p.Dedup.Add(1)
				p.Unchanged.Add(1)
				return nil
			}
		}
		out := s.IngestFile(ctx, path)
		p.Processed.Add(1)
		switch {
		case out.Err != nil:
			p.Errored.Add(1)
		case out.Skipped:
			// File vanished between walk and ingest (hard-deleted by the
			// service) — not an error, not a dedup hit.
		case out.Inserted:
			p.Inserted.Add(1)
		default:
			p.Dedup.Add(1)
		}
		return nil
	})
	s.log().Info("rescan walk finished", "root", root, "supported_files_found", supportedFound)
	return err
}

// Keep separately configured dot-directory roots: an outer scan skips them.
// Reaches also handles symlinks and unreadable ancestors, unlike path prefixes.
func uniqueScanRoots(roots []string) []string {
	out := make([]string, 0, len(roots))
	for i, root := range roots {
		covered := false
		for j, other := range roots {
			if i == j {
				continue
			}
			rootAbs, rootErr := filepath.Abs(root)
			otherAbs, otherErr := filepath.Abs(other)
			if rootErr != nil || otherErr != nil {
				continue
			}
			if rootAbs == otherAbs {
				covered = j < i
			} else {
				covered = musicroots.Reaches(otherAbs, rootAbs, true)
			}
			if covered {
				break
			}
		}
		if !covered {
			out = append(out, root)
		}
	}
	return out
}

// pruneMissing reconciles tracks + ingest_errors against disk: any row under a
// live root whose file no longer exists is hard-deleted. Rows under roots
// that are currently unavailable (e.g. an unmounted drive) are left alone so
// a transient outage never nukes the catalog.
func (s *Service) pruneMissing(ctx context.Context, liveRoots []string, p *RescanProgress) error {
	if s.Library == nil || len(liveRoots) == 0 {
		return nil
	}
	paths, err := s.Library.DistinctPathsUnder(ctx, liveRoots)
	if err != nil {
		return err
	}
	for _, fp := range paths {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if _, err := os.Stat(fp); err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				continue
			}
			if derr := s.Library.HardDeleteByPath(ctx, fp); derr != nil {
				s.log().Warn("prune hard delete failed", "path", fp, "err", derr)
				continue
			}
			p.Pruned.Add(1)
		}
	}
	return nil
}
