// Copyright 2015, David Howden
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package tag

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
)

func getBit(b byte, n uint) bool {
	x := byte(1 << n)
	return (b & x) == x
}

func get7BitChunkedInt(b []byte) int {
	var n int
	for _, x := range b {
		n = n << 7
		n |= int(x)
	}
	return n
}

func getInt(b []byte) int {
	var n int
	for _, x := range b {
		n = n << 8
		n |= int(x)
	}
	return n
}

func readUint64LittleEndian(r io.Reader) (uint64, error) {
	b, err := readBytes(r, 8)
	if err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint64(b), nil
}

// readBytesMaxUpfront is the max up-front allocation allowed
const readBytesMaxUpfront = 10 << 20 // 10MB

// readBytesMax caps a single field. Sizes come straight from the file, and
// the biggest real fields, embedded cover art, run to a few MiB (a FLAC block
// can't pass 16 MiB at all). Without a cap a lying size was honoured up to the
// end of the input, so a 512 MB upload buffered all of itself, twice over
// while the buffer grew, before the read failed.
const readBytesMax = 64 << 20 // 64MB

// readBytesCheckLen is the size from which readBytes first makes sure the
// input holds n more bytes, when the reader can tell. Smaller reads just try.
const readBytesCheckLen = 64 << 10 // 64KB

func readBytes(r io.Reader, n uint) ([]byte, error) {
	if n > readBytesMax {
		return nil, fmt.Errorf("field of %d bytes is over the %d byte limit", n, readBytesMax)
	}
	fits := false
	if n > readBytesCheckLen {
		if left, ok := remaining(r); ok {
			if int64(n) > left {
				return nil, fmt.Errorf("field of %d bytes with %d left: %w", n, left, io.ErrUnexpectedEOF)
			}
			fits = true
		}
	}
	if n > readBytesMaxUpfront && !fits {
		b := &bytes.Buffer{}
		if _, err := io.CopyN(b, r, int64(n)); err != nil {
			return nil, err
		}
		return b.Bytes(), nil
	}

	b := make([]byte, n)
	_, err := io.ReadFull(r, b)
	if err != nil {
		return nil, err
	}
	return b, nil
}

// remaining reports how many bytes are left in r, when r can tell without
// consuming any.
func remaining(r io.Reader) (int64, bool) {
	switch r := r.(type) {
	case interface{ remaining() (int64, bool) }: // unsynchroniser
		return r.remaining()
	case interface{ Len() int }: // bytes.Reader and the like
		return int64(r.Len()), true
	case io.Seeker:
		cur, err := r.Seek(0, io.SeekCurrent)
		if err != nil {
			return 0, false
		}
		end, err := r.Seek(0, io.SeekEnd)
		if err != nil {
			return 0, false
		}
		if _, err := r.Seek(cur, io.SeekStart); err != nil {
			// Lost our place: report nothing left so the read fails.
			return 0, true
		}
		return end - cur, true
	}
	return 0, false
}

func readString(r io.Reader, n uint) (string, error) {
	b, err := readBytes(r, n)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func readUint(r io.Reader, n uint) (uint, error) {
	x, err := readInt(r, n)
	if err != nil {
		return 0, err
	}
	return uint(x), nil
}

func readInt(r io.Reader, n uint) (int, error) {
	b, err := readBytes(r, n)
	if err != nil {
		return 0, err
	}
	return getInt(b), nil
}

func read7BitChunkedUint(r io.Reader, n uint) (uint, error) {
	b, err := readBytes(r, n)
	if err != nil {
		return 0, err
	}
	return uint(get7BitChunkedInt(b)), nil
}

func readUint32LittleEndian(r io.Reader) (uint32, error) {
	b, err := readBytes(r, 4)
	if err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint32(b), nil
}
