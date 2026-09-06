package pinscan

import (
	"context"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/safego"
)

// Run polls after an initial startup delay, then waits interval after each scan.
func Run(ctx context.Context, interval time.Duration, scan func(context.Context)) {
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	timer := time.NewTimer(InitialScanDelay)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			scan(ctx)
			timer.Reset(interval)
		}
	}
}

// Group owns the scan reservations and background jobs for one integration.
// Its zero value is ready to use. It must not be copied after first use.
type Group struct {
	mu       sync.Mutex
	inflight map[uuid.UUID]struct{}
	jobs     sync.WaitGroup
}

func (g *Group) TryBegin(id uuid.UUID) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.inflight == nil {
		g.inflight = map[uuid.UUID]struct{}{}
	}
	if _, ok := g.inflight[id]; ok {
		return false
	}
	g.inflight[id] = struct{}{}
	return true
}
func (g *Group) End(id uuid.UUID) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.inflight, id)
}

// Go runs a task whose id has already been reserved by TryBegin. It releases
// the reservation even after a panic. Call End if loading the pin fails first.
func (g *Group) Go(id uuid.UUID, label string, task func()) {
	g.jobs.Add(1)
	go func() {
		defer g.jobs.Done()
		defer g.End(id)
		defer safego.Recover(label)
		task()
	}()
}

// Wait must be called after polling and manual job submission have stopped.
func (g *Group) Wait() { g.jobs.Wait() }
