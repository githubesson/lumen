package ingest

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestAudioHashRejectsMalformedAPEFooter(t *testing.T) {
	for _, size := range []uint32{0, 1, 31, 4096} {
		data := make([]byte, 160)
		copy(data[128:], "APETAGEX")
		binary.LittleEndian.PutUint32(data[140:144], size)
		path := filepath.Join(t.TempDir(), "malformed.mp3")
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := AudioSHA256(context.Background(), path); err == nil {
			t.Fatalf("accepted invalid APE footer size %d", size)
		}
	}
}

func TestAudioHashExcludesValidAPEFooter(t *testing.T) {
	audio := make([]byte, 128)
	for i := range audio {
		audio[i] = byte(i)
	}
	data := append(append([]byte{}, audio...), make([]byte, 32)...)
	copy(data[128:], "APETAGEX")
	binary.LittleEndian.PutUint32(data[140:144], 32)
	path := filepath.Join(t.TempDir(), "valid.mp3")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	got, err := AudioSHA256(context.Background(), path)
	want := sha256.Sum256(audio)
	if err != nil || got != hex.EncodeToString(want[:]) {
		t.Fatalf("hash = %s, %v", got, err)
	}
}

func TestNativeAudioHashObservesCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := AudioSHA256(ctx, "unused.mp3"); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
}
