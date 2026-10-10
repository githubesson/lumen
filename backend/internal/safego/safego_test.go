package safego

import (
	"errors"
	"testing"
	"time"

	"golang.org/x/sync/singleflight"
)

// DoChan re-raises a panic from its function on a goroutine of its own, so
// without Call this test would not fail: it would crash the test binary.
func TestCallKeepsDoChanPanicFromKillingTheProcess(t *testing.T) {
	var g singleflight.Group
	ch := g.DoChan("key", func() (any, error) {
		return Call("test flight", func() (any, error) {
			var m map[string]int
			m["boom"]++ // assignment to entry in nil map
			return nil, nil
		})
	})
	select {
	case res := <-ch:
		if !errors.Is(res.Err, ErrPanicked) {
			t.Fatalf("err = %v, want ErrPanicked", res.Err)
		}
		if res.Val != nil {
			t.Fatalf("val = %v, want nil", res.Val)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("DoChan never delivered a result")
	}

	// The group is usable again: the key was released.
	v, err, _ := g.Do("key", func() (any, error) {
		return Call("test flight", func() (any, error) { return "ok", nil })
	})
	if err != nil || v != "ok" {
		t.Fatalf("second flight = %v, %v; want ok, nil", v, err)
	}
}

func TestCallPassesResultsThrough(t *testing.T) {
	want := errors.New("plain failure")
	n, err := Call("count", func() (int, error) { return 7, want })
	if n != 7 || err != want {
		t.Fatalf("Call = %d, %v; want 7, %v", n, err, want)
	}
}

func TestCallZeroesResultOnPanic(t *testing.T) {
	s, err := Call("named", func() (string, error) { panic("boom") })
	if s != "" || !errors.Is(err, ErrPanicked) {
		t.Fatalf("Call = %q, %v; want \"\", ErrPanicked", s, err)
	}
}
