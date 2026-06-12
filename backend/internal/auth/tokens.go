package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
)

// RandomToken returns a URL-safe random token with ~n*8 bits of entropy
// and its SHA-256 digest for DB storage.
func RandomToken(n int) (plain string, hash []byte, err error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", nil, err
	}
	plain = base64.RawURLEncoding.EncodeToString(buf)
	sum := sha256.Sum256([]byte(plain))
	return plain, sum[:], nil
}

func HashToken(plain string) []byte {
	sum := sha256.Sum256([]byte(plain))
	return sum[:]
}
