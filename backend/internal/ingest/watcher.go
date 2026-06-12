package ingest

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Watcher debounces fsnotify events and feeds stable paths to the ingest
// service. Deletions are forwarded to the library store for soft-delete.
//
// Call [Refresh] after the set of configured roots changes (e.g. an admin
// added or removed a root via the API) to add/remove watches without
// restarting the process.
type Watcher struct {
	svc      *Service
	debounce time.Duration
	sem      chan struct{} // caps concurrent ingests so a 1000-file burst can't starve the DB pool

	mu      sync.Mutex
	pending map[string]*time.Timer

	fwMu     sync.Mutex
	fw       *fsnotify.Watcher
	watchSet map[string]struct{} // directories currently registered with fw
	roots    []string            // roots currently covered

	// primed flips to true after the initial Refresh. Subsequent Refresh calls
	// treat newly-added directories as "just appeared" and absorb their
	// contents (register subdirs + schedule existing files for ingest). The
	// initial pass skips absorption because existing contents are handled by
	// the explicit Rescan endpoint.
	primed atomic.Bool
}

// ingestConcurrency bounds how many ingests run at once. Matches pgxpool's
// typical max-conns ceiling with headroom — a same-filesystem `mv` of
// thousands of files no longer fans out 1k goroutines fighting for a
// connection.
const ingestConcurrency = 6

func NewWatcher(svc *Service) *Watcher {
	return &Watcher{
		svc:      svc,
		debounce: 2 * time.Second,
		sem:      make(chan struct{}, ingestConcurrency),
		pending:  map[string]*time.Timer{},
		watchSet: map[string]struct{}{},
	}
}

// Run blocks until ctx is cancelled. It watches every configured root
// recursively and re-evaluates the set when [Refresh] is called.
func (w *Watcher) Run(ctx context.Context) error {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	defer fw.Close()

	w.fwMu.Lock()
	w.fw = fw
	w.fwMu.Unlock()

	w.Refresh(ctx)
	w.primed.Store(true)

	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-fw.Events:
			if !ok {
				return nil
			}
			w.handle(ctx, ev)
		case err, ok := <-fw.Errors:
			if !ok {
				return nil
			}
			// inotify buffer overflows and the like surface here. We have no
			// way to learn which specific events were dropped, so trigger a
			// best-effort catch-up walk that re-registers watches and
			// schedules any supported file we know about. SHA dedup handles
			// files that were already ingested.
			w.svc.Logger.Warn("fsnotify error — running catch-up walk", "err", err)
			go w.catchUp(ctx)
		}
	}
}

// Refresh re-reads the configured roots and adds or removes watches so the
// watcher stays in sync. After the initial pass, any directory newly added to
// the watch set is absorbed — its subdirectories are registered and existing
// supported files are scheduled for ingest. Safe to call from any goroutine.
func (w *Watcher) Refresh(ctx context.Context) {
	w.fwMu.Lock()
	if w.fw == nil {
		w.fwMu.Unlock()
		return
	}
	newRoots := w.svc.AllRoots(ctx)

	// Build the set of directories that should be watched.
	want := map[string]struct{}{}
	for _, root := range newRoots {
		if root == "" {
			continue
		}
		_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.Type()&fs.ModeSymlink != 0 {
				return nil
			}
			if !d.IsDir() {
				return nil
			}
			if p != root && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			want[p] = struct{}{}
			return nil
		})
	}

	for p := range w.watchSet {
		if _, keep := want[p]; !keep {
			_ = w.fw.Remove(p)
			delete(w.watchSet, p)
		}
	}
	var addedRoots []string
	for p := range want {
		if _, have := w.watchSet[p]; have {
			continue
		}
		if err := w.fw.Add(p); err != nil {
			w.svc.Logger.Warn("fsnotify add failed", "path", p, "err", err)
			continue
		}
		w.watchSet[p] = struct{}{}
		addedRoots = append(addedRoots, p)
	}
	w.roots = newRoots
	w.fwMu.Unlock()

	// Only absorb newly-added dirs after the initial prime. A root added via
	// the admin UI (and therefore containing pre-existing files) is absorbed
	// here; startup is not, because rescan/user action handles the initial
	// population.
	if w.primed.Load() {
		for _, d := range addedRoots {
			w.absorbDir(ctx, d)
		}
	}
}

func (w *Watcher) handle(ctx context.Context, ev fsnotify.Event) {
	switch {
	case ev.Has(fsnotify.Create):
		info, err := lstatOrNil(ev.Name)
		if err == nil && info != nil && info.IsDir() {
			// A new directory appeared. Registering just this one dir is not
			// enough — on Linux, moving a populated directory into a watched
			// root fires a single IN_MOVED_TO at the directory, with no
			// per-file events for the contents that came with it. Walk and
			// absorb so nothing is missed.
			w.absorbDir(ctx, ev.Name)
			return
		}
		if isSupportedRegularFile(ev.Name) {
			w.schedule(ctx, ev.Name)
		}
	case ev.Has(fsnotify.Write):
		if isSupportedRegularFile(ev.Name) {
			w.schedule(ctx, ev.Name)
		}
	case ev.Has(fsnotify.Remove), ev.Has(fsnotify.Rename):
		if IsSupported(ev.Name) {
			_ = w.svc.Library.SoftDeleteByPath(ctx, ev.Name)
		}
	}
}

// absorbDir walks `root`, registering watches for every subdirectory and
// scheduling every supported file for ingest. Used both when a new directory
// appears inside a watched tree (Create event) and when a new music root is
// wired up via Refresh — in both cases the event stream alone can't be
// trusted to reveal already-present contents.
func (w *Watcher) absorbDir(ctx context.Context, root string) {
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		if d.IsDir() {
			if p != root && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			w.fwMu.Lock()
			if _, have := w.watchSet[p]; !have {
				if w.fw != nil {
					if err := w.fw.Add(p); err != nil {
						w.svc.Logger.Warn("fsnotify add failed", "path", p, "err", err)
					} else {
						w.watchSet[p] = struct{}{}
					}
				}
			}
			w.fwMu.Unlock()
			return nil
		}
		if isSupportedRegularFile(p) {
			w.schedule(ctx, p)
		}
		return nil
	})
}

// catchUp re-runs Refresh (to pick up any dirs that appeared while the event
// channel was saturated) and then schedules every supported file under every
// live root for ingest. SHA-based dedup means already-known files are cheap
// no-ops; the goal is to recover from fsnotify drops without losing anything.
func (w *Watcher) catchUp(ctx context.Context) {
	w.Refresh(ctx)
	for _, root := range w.svc.AllRoots(ctx) {
		if !isNonSymlinkDir(root) {
			continue
		}
		w.absorbDir(ctx, root)
	}
}

func (w *Watcher) schedule(ctx context.Context, path string) {
	if !isSupportedRegularFile(path) {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if t, ok := w.pending[path]; ok {
		t.Stop()
	}
	w.pending[path] = time.AfterFunc(w.debounce, func() {
		w.mu.Lock()
		delete(w.pending, path)
		w.mu.Unlock()
		select {
		case w.sem <- struct{}{}:
		case <-ctx.Done():
			return
		}
		defer func() { <-w.sem }()
		if !isSupportedRegularFile(path) {
			return
		}
		_ = w.svc.IngestFile(ctx, path)
	})
}

func lstatOrNil(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	return info, nil
}

func isNonSymlinkDir(path string) bool {
	info, err := lstatOrNil(path)
	return err == nil && info != nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0
}

func isSupportedRegularFile(path string) bool {
	if !IsSupported(path) {
		return false
	}
	info, err := lstatOrNil(path)
	return err == nil && info != nil && info.Mode()&os.ModeSymlink == 0 && info.Mode().IsRegular()
}
