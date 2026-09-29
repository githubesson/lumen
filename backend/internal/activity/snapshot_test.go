package activity

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestHubSharesSnapshotsAndDropsThemOnDisconnect(t *testing.T) {
	hub := NewHub()
	user := uuid.New()
	_, disconnectA := hub.Register(user, "a")
	_, disconnectB := hub.Register(user, "b")
	defer disconnectA()
	defer disconnectB()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var calls atomic.Int64
	load := func() ([]Activity, error) {
		calls.Add(1)
		return []Activity{{UserID: user, TrackID: "song"}}, nil
	}
	readers := func() {
		t.Helper()
		var wg sync.WaitGroup
		for range 32 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				rows, err := hub.RecentActivity(ctx, user, load)
				if err != nil || len(rows) != 1 || rows[0].TrackID != "song" {
					t.Errorf("snapshot = %+v, %v", rows, err)
				}
			}()
		}
		wg.Wait()
	}
	readers()
	if got := calls.Load(); got != 1 {
		t.Fatalf("shared load used %d reads, want 1", got)
	}
	hub.NotifyActivity(user)
	readers()
	if got := calls.Load(); got != 2 {
		t.Fatalf("mutation used %d total reads, want 2", got)
	}
	other := uuid.New()
	_, disconnectOther := hub.Register(other, "other")
	defer disconnectOther()
	if _, err := hub.RecentActivity(ctx, other, load); err != nil || calls.Load() != 3 {
		t.Fatalf("another user's snapshot was reused: %v, calls=%d", err, calls.Load())
	}
	disconnectA()
	disconnectB()
	_, reconnect := hub.Register(user, "a")
	defer reconnect()
	readers()
	if calls.Load() != 4 {
		t.Fatalf("reconnect reused an old snapshot: calls=%d", calls.Load())
	}
}

func TestSnapshotInvalidationDuringReadCannotPublishStaleRows(t *testing.T) {
	var snapshot playbackSnapshot
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int64
	load := func() ([]Activity, error) {
		if calls.Add(1) == 1 {
			close(started)
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			return []Activity{{TrackID: "old"}}, nil
		}
		return []Activity{{TrackID: "new"}}, nil
	}
	done := make(chan []Activity, 1)
	go func() {
		rows, err := snapshot.get(ctx, load)
		if err != nil {
			t.Errorf("first reader: %v", err)
		}
		done <- rows
	}()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	snapshot.invalidate()
	rows, err := snapshot.get(ctx, load)
	close(release)
	if err != nil || len(rows) != 1 || rows[0].TrackID != "new" {
		t.Fatalf("new reader: %+v, %v", rows, err)
	}
	select {
	case rows := <-done:
		if len(rows) != 1 || rows[0].TrackID != "new" {
			t.Fatalf("old flight returned stale rows: %+v", rows)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if calls.Load() != 2 {
		t.Fatalf("got %d reads, want 2 generations", calls.Load())
	}
}

func TestSnapshotCanceledWaiterDoesNotCancelSharedRead(t *testing.T) {
	var snapshot playbackSnapshot
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	waitCtx, cancelWait := context.WithCancel(ctx)
	started, release := make(chan struct{}), make(chan struct{})
	load := func() ([]Activity, error) {
		close(started)
		select {
		case <-release:
			return []Activity{}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	done := make(chan error, 1)
	go func() { _, err := snapshot.get(waitCtx, load); done <- err }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	cancelWait()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled waiter = %v", err)
	}
	close(release)
	for range 2 {
		rows, err := snapshot.get(ctx, load)
		if err != nil || rows == nil || len(rows) != 0 {
			t.Fatalf("shared empty snapshot = %+v, %v", rows, err)
		}
	}
}

func TestSnapshotRetriesFailuresAndExpires(t *testing.T) {
	var snapshot playbackSnapshot
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := snapshot.get(ctx, func() ([]Activity, error) { panic("injected") }); err == nil {
		t.Fatal("loader panic did not fail the flight")
	}
	var calls int
	load := func() ([]Activity, error) {
		calls++
		if calls == 1 {
			return nil, errors.New("temporary failure")
		}
		return []Activity{{TrackID: "song"}}, nil
	}
	if _, err := snapshot.get(ctx, load); err == nil {
		t.Fatal("failed load unexpectedly succeeded")
	}
	if _, err := snapshot.get(ctx, load); err != nil {
		t.Fatal(err)
	}
	snapshot.mu.Lock()
	snapshot.at = time.Now().Add(-playbackSnapshotTTL)
	snapshot.mu.Unlock()
	if _, err := snapshot.get(ctx, load); err != nil || calls != 3 {
		t.Fatalf("expired snapshot wasn't refreshed: %v, calls=%d", err, calls)
	}
}
