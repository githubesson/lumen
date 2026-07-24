// Package safego provides panic isolation for goroutines.
//
// chi's Recoverer only wraps the request goroutine. Anything spawned off a
// request — a Last.fm submission, a rescan, an HLS segment writer, a websocket
// pump — escapes it, so a single nil-deref or index panic in one of those
// takes down the whole process, dropping every in-flight request and playback
// session with it.
//
// Wrap those goroutine bodies here instead.
package safego

import (
	"log/slog"
	"runtime/debug"
)

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
