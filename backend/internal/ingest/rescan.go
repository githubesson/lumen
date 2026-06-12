package ingest

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
)

// RescanProgress is updated during a walk; callers can snapshot it for
// progress reporting.
type RescanProgress struct {
	Total     atomic.Int64
	Processed atomic.Int64
	Inserted  atomic.Int64
	Dedup     atomic.Int64
	Errored   atomic.Int64
	Pruned    atomic.Int64
	Done      atomic.Bool
}

// Rescan walks every configured music root and ingests every supported audio
// file. Safe to call again later to pick up new files — deduplication is by
// audio SHA-256. After the walks, reconciles the DB against disk and removes
// rows for files that no longer exist under any live root.
func (s *Service) Rescan(ctx context.Context, p *RescanProgress) error {
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
		before := p.Processed.Load()
		beforeInserted := p.Inserted.Load()
		if err := s.rescanRoot(ctx, root, p); err != nil {
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
		"errored", p.Errored.Load(),
		"pruned", p.Pruned.Load(),
	)
	return nil
}

func (s *Service) rescanRoot(ctx context.Context, root string, p *RescanProgress) error {
	s.log().Info("rescan walking", "root", root)
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
