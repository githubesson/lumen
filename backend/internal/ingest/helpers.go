package ingest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
)

// coverKey returns a short prefix of the SHA-256 of cover bytes, used to name
// cover art files in storage.
func coverKey(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])[:32]
}

func byteReader(b []byte) io.Reader { return bytes.NewReader(b) }
