package activity

import (
	"context"
	"fmt"
	"sync"
	"time"
)

const playbackSnapshotTTL = 5 * time.Second

type playbackSnapshot struct {
	mu         sync.Mutex
	generation uint64
	valid      bool
	rows       []Activity
	at         time.Time
	flight     *snapshotFlight
}

type snapshotFlight struct {
	done       chan struct{}
	generation uint64
	err        error
}

func (s *playbackSnapshot) invalidate() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.generation++
	s.valid = false
	s.rows = nil
	s.flight = nil
}

func (s *playbackSnapshot) get(ctx context.Context, load func() ([]Activity, error)) ([]Activity, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		s.mu.Lock()
		if s.valid && time.Since(s.at) < playbackSnapshotTTL {
			rows := s.rows
			s.mu.Unlock()
			return rows, nil
		}
		f := s.flight
		if f == nil {
			f = &snapshotFlight{done: make(chan struct{}), generation: s.generation}
			s.flight = f
			go s.fetch(f, load)
		}
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-f.done:
			s.mu.Lock()
			current := f.generation == s.generation
			s.mu.Unlock()
			if current && f.err != nil {
				return nil, f.err
			}
			// A mutation during the read requires a new snapshot. Superseded
			// flights never repopulate the cache or return stale state.
		}
	}
}

func (s *playbackSnapshot) fetch(f *snapshotFlight, load func() ([]Activity, error)) {
	var rows []Activity
	func() {
		defer func() {
			if p := recover(); p != nil {
				f.err = fmt.Errorf("playback snapshot loader panicked: %v", p)
			}
		}()
		rows, f.err = load()
	}()
	s.mu.Lock()
	if s.flight == f {
		s.flight = nil
		if f.err == nil {
			s.rows, s.at, s.valid = rows, time.Now(), true
		}
	}
	s.mu.Unlock()
	close(f.done)
}
