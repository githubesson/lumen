package ingest

import (
	"bufio"
	"io"
)

// bufferedReadSeeker serves an io.ReadSeeker's reads from a buffer. The tag
// parser reads most fields a few bytes at a time and hops between them with
// short relative seeks; straight from an *os.File each of those was a
// syscall, so a crafted file of millions of tiny atoms or blocks cost
// millions of them.
type bufferedReadSeeker struct {
	rs  io.ReadSeeker
	buf *bufio.Reader
	pos int64 // offset of the next byte Read returns
}

// newBufferedReadSeeker wraps rs, which must be at offset 0 (a file just
// opened).
func newBufferedReadSeeker(rs io.ReadSeeker) *bufferedReadSeeker {
	return &bufferedReadSeeker{rs: rs, buf: bufio.NewReader(rs)}
}

func (b *bufferedReadSeeker) Read(p []byte) (int, error) {
	n, err := b.buf.Read(p)
	b.pos += int64(n)
	return n, err
}

func (b *bufferedReadSeeker) Seek(offset int64, whence int) (int64, error) {
	if whence == io.SeekCurrent {
		// Reporting the offset, or skipping what's already buffered, needs
		// no syscall.
		if offset >= 0 && offset <= int64(b.buf.Buffered()) {
			n, _ := b.buf.Discard(int(offset))
			b.pos += int64(n)
			return b.pos, nil
		}
		// rs is ahead of us by whatever is buffered, so seek from the start.
		offset, whence = b.pos+offset, io.SeekStart
	}
	pos, err := b.rs.Seek(offset, whence)
	if err != nil {
		// A failed seek leaves rs where it was, so the buffer still lines up.
		return 0, err
	}
	b.buf.Reset(b.rs)
	b.pos = pos
	return pos, nil
}
