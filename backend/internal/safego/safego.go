// Package safego provides panic isolation for goroutines.
//
// chi's Recoverer only wraps the request goroutine. Anything spawned off a
// request — a Last.fm submission, a rescan, an HLS segment writer, a websocket
// pump — escapes it, so a single nil-deref or index panic in one of those
// takes down the whole process, dropping every in-flight request and playback
// session with it.
//
// Wrap those goroutine bodies here instead, and singleflight functions in
// Call: singleflight runs them on a goroutine it re-raises panics from.
package safego

import (
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
)

// ErrPanicked marks the error Call returns for a panic.
var ErrPanicked = errors.New("panicked")

// Run executes fn, converting a panic into an error log. Use it inside a
// goroutine body that already has its own defers (WaitGroup.Done, cleanup)
// so the recover does not displace them.
func Run(name string, fn func()) {
	defer Recover(name)
	fn()
}

// Recover is the deferrable form of Run, for goroutine bodies that cannot be
// expressed as a single closure:
//
//	go func() {
//	    defer wg.Done()
//	    defer safego.Recover("scan worker")
//	    ...
//	}()
func Recover(name string) {
	if p := recover(); p != nil {
		slog.Error("goroutine panicked",
			"goroutine", name, "panic", p, "stack", string(debug.Stack()))
	}
}

// Go starts fn in a new goroutine under Run.
func Go(name string, fn func()) {
	go Run(name, fn)
}

// Call runs fn and returns its results, converting a panic into a logged
// error that wraps ErrPanicked.
//
// Use it inside every singleflight function. Group.DoChan re-raises a panic
// from its function with `go panic(e)`, on a goroutine of its own that no
// recover can reach, so the process dies however well the callers are
// guarded. Group.Do re-panics in each caller instead, which is only safe
// while every caller recovers.
func Call[T any](name string, fn func() (T, error)) (v T, err error) {
	defer func() {
		if p := recover(); p != nil {
			slog.Error("call panicked",
				"call", name, "panic", p, "stack", string(debug.Stack()))
			var zero T
			v, err = zero, fmt.Errorf("%s %w: %v", name, ErrPanicked, p)
		}
	}()
	return fn()
}
