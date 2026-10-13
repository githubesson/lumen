package ffsafe

import (
	"os/exec"
	"sync"
)

var (
	hasFFmpeg  = sync.OnceValue(func() bool { return onPath("ffmpeg") })
	hasFFprobe = sync.OnceValue(func() bool { return onPath("ffprobe") })
)

// HasFFmpeg reports whether ffmpeg is on $PATH. Checked once.
func HasFFmpeg() bool { return hasFFmpeg() }

// HasFFprobe reports whether ffprobe is on $PATH. Checked once.
func HasFFprobe() bool { return hasFFprobe() }

func onPath(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// Tail is an io.Writer that keeps only the last max bytes written to it: the
// bottom of a tool's stderr, for an error message, without buffering all of
// ffmpeg's progress lines or a hostile input's endless warnings.
type Tail struct {
	max int
	buf []byte
}

// NewTail returns a Tail that keeps the last max bytes.
func NewTail(max int) *Tail { return &Tail{max: max} }

func (t *Tail) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = t.buf[len(t.buf)-t.max:]
	}
	return len(p), nil
}

func (t *Tail) String() string { return string(t.buf) }
