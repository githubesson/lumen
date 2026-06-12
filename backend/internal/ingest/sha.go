package ingest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dhowden/tag"
)

const (
	ffmpegHashTimeout  = 45 * time.Second
	subprocessOutLimit = 64 * 1024
	subprocessErrTail  = 4 * 1024
)

// AudioSHA256 returns a hex-encoded hash of just the audio stream (not the
// container/tag bytes) so dedup survives tag edits, embedded-cover changes,
// ID3v2.2 vs v2.3 reauthoring, trailing ID3v1/APE tags, etc.
//
// Preference order, fastest to slowest:
//
//  1. Native in-process strippers for MP3 and FLAC — read a few header bytes,
//     compute the audio-byte range, SHA-256 the range. No forks, no decode.
//  2. ffmpeg `-c copy -f hash sha256` on the audio stream — works for M4A/
//     MP4/OGG/OPUS/WAV/AAC and anything else ffmpeg can demux.
//  3. dhowden/tag.Sum — pure-Go fallback if ffmpeg isn't on $PATH.
//  4. Full-file SHA-256 — last resort. Retagging such a file registers as new.
func AudioSHA256(ctx context.Context, path string) (string, error) {
	if sum, err := nativeAudioSHA256(path); err == nil {
		return sum, nil
	} else if !errors.Is(err, errFormatUnsupportedNative) {
		// Native handler recognised the format but failed (e.g. truncated
		// file). Don't silently fall back — surface the error so ingestion
		// records it instead of storing a garbage full-file hash.
		return "", err
	}

	if hasFFmpeg() {
		if sum, err := ffmpegAudioSHA256(ctx, path); err == nil {
			return sum, nil
		} else if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return "", err
		}
	}

	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if sum, err := tag.Sum(f); err == nil {
		return sum, nil
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

var errFormatUnsupportedNative = errors.New("no native audio-hash for this extension")

func nativeAudioSHA256(path string) (string, error) {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".mp3":
		return mp3AudioSHA256(path)
	case ".flac":
		return flacAudioSHA256(path)
	default:
		return "", errFormatUnsupportedNative
	}
}

// mp3AudioSHA256 hashes an MP3's audio-frame region: the file with any leading
// ID3v2 tag and any trailing ID3v1 / APE / Lyrics3 tag sliced off. The bytes
// in between are concatenated MPEG audio frames — the same bytes ffmpeg emits
// in `-c copy -f hash`.
func mp3AudioSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	start, end, err := mp3AudioBounds(f, info.Size())
	if err != nil {
		return "", fmt.Errorf("mp3 %s: %w", path, err)
	}
	h := sha256.New()
	if _, err := io.Copy(h, io.NewSectionReader(f, start, end-start)); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// mp3AudioBounds returns the [start, end) byte range covering the MPEG audio
// frames inside an MP3 file — i.e. the file with any leading ID3v2 header and
// any trailing ID3v1 / APE / Lyrics3 tag sliced off. Shared by the SHA hasher
// and the duration probe so both agree on where the audio stream lives.
func mp3AudioBounds(f *os.File, size int64) (start, end int64, err error) {
	start, end = 0, size

	// Leading ID3v2 (v2.2 through v2.4). 10-byte header:
	//   "ID3" | version(2) | flags(1) | size(4, syncsafe)
	// Size excludes header; v2.4 can add a 10-byte footer (flags bit 0x10).
	hdr := make([]byte, 10)
	if n, _ := f.ReadAt(hdr, 0); n == 10 && bytes.Equal(hdr[:3], []byte("ID3")) {
		tagSize := syncsafe28(hdr[6:10])
		start = 10 + int64(tagSize)
		if hdr[5]&0x10 != 0 {
			start += 10
		}
	}

	// Trailing tags, walking backwards: [APE] [Lyrics3] [ID3v1]. Any of
	// the three can be absent; detect, trim, repeat.
	for {
		shrunk := false
		if end-start >= 128 {
			tail := make([]byte, 128)
			if _, rerr := f.ReadAt(tail, end-128); rerr == nil && bytes.Equal(tail[:3], []byte("TAG")) {
				end -= 128
				shrunk = true
				continue
			}
		}
		if end-start >= 32 {
			tail := make([]byte, 32)
			if _, rerr := f.ReadAt(tail, end-32); rerr == nil && bytes.Equal(tail[:8], []byte("APETAGEX")) {
				apeSize := int64(binary.LittleEndian.Uint32(tail[12:16]))
				flags := binary.LittleEndian.Uint32(tail[20:24])
				end -= apeSize
				if flags&(1<<31) != 0 {
					end -= 32
				}
				shrunk = true
				continue
			}
		}
		if end-start >= 15 {
			tail := make([]byte, 15)
			if _, rerr := f.ReadAt(tail, end-15); rerr == nil && bytes.Equal(tail[6:], []byte("LYRICS200")) {
				if n, ok := parseASCIIInt(tail[:6]); ok {
					end -= int64(n) + 15
					shrunk = true
					continue
				}
			}
		}
		if !shrunk {
			break
		}
	}
	if start >= end {
		return 0, 0, fmt.Errorf("tag headers left no audio bytes (start=%d end=%d)", start, end)
	}
	return start, end, nil
}

// flacAudioSHA256 hashes the audio frames of a FLAC file — everything after
// the "fLaC" magic and the metadata block chain. Metadata blocks (including
// VORBIS_COMMENT and PICTURE, which are the "tags") are skipped; the audio
// frame stream at the end is hashed. Trailing ID3v1 is tolerated but rare.
func flacAudioSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	size := info.Size()

	// Tolerate a leading ID3v2 tag (some FLAC files carry one even though
	// the spec frowns on it).
	var off int64
	hdr := make([]byte, 10)
	if n, _ := f.ReadAt(hdr, 0); n == 10 && bytes.Equal(hdr[:3], []byte("ID3")) {
		off = 10 + int64(syncsafe28(hdr[6:10]))
		if hdr[5]&0x10 != 0 {
			off += 10
		}
	}

	magic := make([]byte, 4)
	if _, err := f.ReadAt(magic, off); err != nil {
		return "", err
	}
	if string(magic) != "fLaC" {
		return "", fmt.Errorf("flac %s: missing fLaC magic at offset %d", path, off)
	}
	off += 4

	// Metadata-block header: 1 byte (bit7=last, bits6-0=type), 3 bytes BE
	// size. Keep reading until the last-block flag.
	mbh := make([]byte, 4)
	for {
		if _, err := f.ReadAt(mbh, off); err != nil {
			return "", err
		}
		last := mbh[0]&0x80 != 0
		bodySize := int64(mbh[1])<<16 | int64(mbh[2])<<8 | int64(mbh[3])
		off += 4 + bodySize
		if last {
			break
		}
	}

	end := size
	// Optional trailing ID3v1 (not part of the FLAC spec but seen in the wild).
	if end-off >= 128 {
		tail := make([]byte, 128)
		if _, err := f.ReadAt(tail, end-128); err == nil && bytes.Equal(tail[:3], []byte("TAG")) {
			end -= 128
		}
	}

	if off >= end {
		return "", fmt.Errorf("flac %s: metadata chain consumed all bytes", path)
	}
	h := sha256.New()
	if _, err := io.Copy(h, io.NewSectionReader(f, off, end-off)); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// syncsafe28 decodes a 4-byte syncsafe integer (7 bits per byte, MSB zero).
func syncsafe28(b []byte) uint32 {
	return uint32(b[0]&0x7f)<<21 | uint32(b[1]&0x7f)<<14 | uint32(b[2]&0x7f)<<7 | uint32(b[3]&0x7f)
}

func parseASCIIInt(b []byte) (int, bool) {
	n := 0
	for _, c := range b {
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + int(c-'0')
	}
	return n, true
}

var (
	ffmpegOnce    sync.Once
	ffmpegPresent bool
)

func hasFFmpeg() bool {
	ffmpegOnce.Do(func() {
		_, err := exec.LookPath("ffmpeg")
		ffmpegPresent = err == nil
	})
	return ffmpegPresent
}

// ffmpegAudioSHA256 shells out to ffmpeg to stream-copy just the audio packets
// (no decode) into ffmpeg's hash muxer. Output looks like "SHA256=<hex>\n".
func ffmpegAudioSHA256(parent context.Context, path string) (string, error) {
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, ffmpegHashTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-nostdin", "-v", "error",
		"-i", path,
		"-map", "0:a",
		"-c", "copy",
		"-f", "hash", "-hash", "sha256",
		"-",
	)
	out := &boundedBytes{max: subprocessOutLimit}
	stderr := &lastBytes{max: subprocessErrTail}
	cmd.Stdout = out
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", fmt.Errorf("ffmpeg hash: %w", ctx.Err())
		}
		return "", fmt.Errorf("ffmpeg hash: %w (stderr tail=%s)", err, strings.TrimSpace(stderr.String()))
	}
	if out.Truncated() {
		return "", fmt.Errorf("ffmpeg hash output exceeded %d bytes", subprocessOutLimit)
	}
	s := strings.TrimSpace(out.String())
	_, sum, ok := strings.Cut(s, "=")
	if !ok || sum == "" {
		return "", fmt.Errorf("unexpected ffmpeg hash output: %q", s)
	}
	return strings.ToLower(sum), nil
}

// boundedBytes is an io.Writer that keeps the first max bytes and discards
// anything after that. Callers can reject truncated output after the process
// exits without ever retaining unbounded subprocess output in memory.
type boundedBytes struct {
	max       int
	buf       []byte
	truncated bool
}

func (b *boundedBytes) Write(p []byte) (int, error) {
	if b.max <= 0 {
		b.truncated = b.truncated || len(p) > 0
		return len(p), nil
	}
	remaining := b.max - len(b.buf)
	if remaining > 0 {
		if len(p) <= remaining {
			b.buf = append(b.buf, p...)
		} else {
			b.buf = append(b.buf, p[:remaining]...)
			b.truncated = true
		}
	} else if len(p) > 0 {
		b.truncated = true
	}
	return len(p), nil
}

func (b *boundedBytes) Bytes() []byte { return b.buf }

func (b *boundedBytes) String() string { return string(b.buf) }

func (b *boundedBytes) Truncated() bool { return b.truncated }

// lastBytes retains only the tail of subprocess output for compact errors.
type lastBytes struct {
	max int
	buf []byte
}

func (l *lastBytes) Write(p []byte) (int, error) {
	l.buf = append(l.buf, p...)
	if len(l.buf) > l.max {
		l.buf = l.buf[len(l.buf)-l.max:]
	}
	return len(p), nil
}

func (l *lastBytes) String() string { return string(l.buf) }
