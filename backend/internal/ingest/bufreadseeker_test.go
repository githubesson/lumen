package ingest

import (
	"bytes"
	"io"
	"math/rand/v2"
	"testing"
)

// The buffered reader must behave exactly like the reader under it, through
// any mix of reads and seeks.
func TestBufferedReadSeekerMatchesUnderlying(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	data := make([]byte, 64<<10)
	for i := range data {
		data[i] = byte(rng.Uint32())
	}
	want := bytes.NewReader(data)
	got := newBufferedReadSeeker(bytes.NewReader(data))
	size := int64(len(data))
	for i := 0; i < 20000; i++ {
		if rng.IntN(2) == 0 {
			n := rng.IntN(9000)
			a, b := make([]byte, n), make([]byte, n)
			na, ea := io.ReadFull(want, a)
			nb, eb := io.ReadFull(got, b)
			if na != nb || ea != eb || !bytes.Equal(a[:na], b[:nb]) {
				t.Fatalf("step %d: read %d bytes, %v; want %d, %v", i, nb, eb, na, ea)
			}
			continue
		}
		var offset int64
		whence := rng.IntN(3)
		switch whence {
		case io.SeekStart:
			offset = rng.Int64N(size+20) - 10
		case io.SeekCurrent:
			offset = rng.Int64N(10000) - 5000
		case io.SeekEnd:
			offset = rng.Int64N(size+20) - size - 10
		}
		pa, ea := want.Seek(offset, whence)
		pb, eb := got.Seek(offset, whence)
		if (ea == nil) != (eb == nil) || (ea == nil && pa != pb) {
			t.Fatalf("step %d: Seek(%d, %d) = %d, %v; want %d, %v", i, offset, whence, pb, eb, pa, ea)
		}
	}
}

type countingReadSeeker struct {
	io.ReadSeeker
	reads, seeks int
}

func (c *countingReadSeeker) Read(p []byte) (int, error) {
	c.reads++
	return c.ReadSeeker.Read(p)
}

func (c *countingReadSeeker) Seek(offset int64, whence int) (int64, error) {
	c.seeks++
	return c.ReadSeeker.Seek(offset, whence)
}

// Small reads with short skips between them, the tag parser's pattern, reach
// the file a buffer at a time.
func TestBufferedReadSeekerBatchesSmallReads(t *testing.T) {
	data := make([]byte, 1<<20)
	file := &countingReadSeeker{ReadSeeker: bytes.NewReader(data)}
	r := newBufferedReadSeeker(file)
	buf := make([]byte, 4)
	for {
		if _, err := io.ReadFull(r, buf); err != nil {
			break
		}
		if _, err := r.Seek(0, io.SeekCurrent); err != nil {
			t.Fatal(err)
		}
		if _, err := r.Seek(4, io.SeekCurrent); err != nil {
			t.Fatal(err)
		}
	}
	if limit := len(data)/4096 + 2; file.reads > limit || file.seeks > limit {
		t.Fatalf("%d reads and %d seeks reached a %d-byte file", file.reads, file.seeks, len(data))
	}
}
