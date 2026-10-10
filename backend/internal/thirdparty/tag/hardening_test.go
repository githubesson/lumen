package tag

// Regression tests for Lumen's hardening of the fork: crafted files must come
// back as errors, quickly and without large allocations, never as panics.

import (
	"bytes"
	"testing"
)

// A file of nothing but nested moov headers (the 52 MB crasher, cut down)
// stops at the depth limit instead of recursing until the stack overflows,
// and reads nothing past it.
func TestReadAtomsNestingLimit(t *testing.T) {
	ftyp := atom("ftyp", []byte("M4A "), make([]byte, 4))
	moov := []byte{0, 0, 0, 8, 'm', 'o', 'o', 'v'}

	ok := append(append([]byte(nil), ftyp...), bytes.Repeat(moov, maxAtomDepth)...)
	if _, err := ReadFrom(bytes.NewReader(ok)); err != nil {
		t.Fatalf("%d nested atoms: %v", maxAtomDepth, err)
	}

	deep := append(append([]byte(nil), ftyp...), bytes.Repeat(moov, 1<<20)...)
	r := bytes.NewReader(deep)
	if _, err := ReadFrom(r); err == nil {
		t.Fatal("a million nested atoms parsed without error")
	}
	if read, limit := r.Size()-int64(r.Len()), len(ftyp)+len(moov)*(maxAtomDepth+1); read > int64(limit) {
		t.Fatalf("read %d bytes, want the parser to stop within %d", read, limit)
	}
}
