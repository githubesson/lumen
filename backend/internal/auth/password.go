package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"

	"golang.org/x/crypto/argon2"
)

type argonParams struct {
	memory  uint32
	time    uint32
	threads uint8
	saltLen uint32
	keyLen  uint32
}

var defaultArgon = argonParams{
	memory:  64 * 1024,
	time:    3,
	threads: 2,
	saltLen: 16,
	keyLen:  32,
}

func HashPassword(pw string) (string, error) {
	salt := make([]byte, defaultArgon.saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	p := defaultArgon
	key := argon2.IDKey([]byte(pw), salt, p.time, p.memory, p.threads, p.keyLen)
	return fmt.Sprintf(
		"$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version,
		p.memory, p.time, p.threads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

var ErrInvalidHash = errors.New("invalid password hash")

func VerifyPassword(pw, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, ErrInvalidHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return false, ErrInvalidHash
	}
	if version != argon2.Version {
		return false, ErrInvalidHash
	}
	var mem, t uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &mem, &t, &threads); err != nil {
		return false, ErrInvalidHash
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, ErrInvalidHash
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, ErrInvalidHash
	}
	got := argon2.IDKey([]byte(pw), salt, t, mem, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(want, got) == 1, nil
}

// DummyHash returns a precomputed Argon2id hash used by login handlers to
// equalize VerifyPassword timing on a user-not-found path. Without this,
// "username doesn't exist" returns instantly while "wrong password" pays the
// Argon2id cost, leaking valid usernames over the network.
//
// Computed lazily on first call and cached for the process lifetime.
var DummyHash = sync.OnceValue(func() string {
	h, err := HashPassword("dummy-login-timing-filler-not-a-real-credential")
	if err != nil {
		// Unreachable in practice; HashPassword only fails on rand.Read failure.
		panic(fmt.Errorf("auth: precompute dummy hash: %w", err))
	}
	return h
})
