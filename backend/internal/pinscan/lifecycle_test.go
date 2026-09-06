package pinscan

import (
	"sync"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
)

func TestGroupReservesPinOnceAcrossConcurrentStarts(t *testing.T) {
	var g Group
	id := uuid.New()
	var starts atomic.Int32
	var contenders sync.WaitGroup
	for i := 0; i < 32; i++ {
		contenders.Add(1)
		go func() {
			defer contenders.Done()
			if g.TryBegin(id) {
				starts.Add(1)
			}
		}()
	}
	contenders.Wait()
	if got := starts.Load(); got != 1 {
		t.Fatalf("got %d owners for one pin", got)
	}
	g.End(id)
	if !g.TryBegin(id) {
		t.Fatal("failed to release reservation")
	}
	g.End(id)
}

func TestGroupReleasesAndWaitsAfterPanic(t *testing.T) {
	var g Group
	id := uuid.New()
	if !g.TryBegin(id) {
		t.Fatal("could not reserve pin")
	}
	g.Go(id, "test scan", func() { panic("failed scan") })
	g.Wait()
	if !g.TryBegin(id) {
		t.Fatal("panic leaked reservation")
	}
	var completed bool
	g.Go(id, "retry scan", func() { completed = true })
	g.Wait()
	if !completed {
		t.Fatal("Wait returned before retry completed")
	}
}
