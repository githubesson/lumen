package ingest

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// AudioInfo is decode-free summary metadata about an audio stream.
// Populated by in-process parsers; every field is "unknown" = 0.
type AudioInfo struct {
	DurationMS int
	Bitrate    int // bits per second (0 when unknown)
	SampleRate int
	Channels   int
}

// ErrProbeUnsupported is returned by ProbeAudio for file formats without a
// native parser. Callers should treat it as "unknown duration" rather than an
// error — the track still ingests, duration is just left at 0.
var ErrProbeUnsupported = errors.New("no native audio probe for this extension")

// ProbeAudio reads the minimum needed to extract duration + nominal format
// info. Strategy:
//
//  1. MP3 → in-process: first audio frame + Xing/Info/VBRI header.
//  2. FLAC → in-process: STREAMINFO metadata block.
//  3. Everything else (m4a/mp4/ogg/opus/wav/aac/…) or a native parser that
//     errored (corrupt MP3, missing STREAMINFO, etc.) → ffprobe when it's
//     on $PATH.
//
// Returns ErrProbeUnsupported only when the format isn't recognised AND
// ffprobe is unavailable. Callers should treat that as "unknown duration"
// rather than an ingest failure.
func ProbeAudio(ctx context.Context, path string) (*AudioInfo, error) {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".mp3":
		if info, err := probeMP3(path); err == nil {
			return info, nil
		}
	case ".flac":
		if info, err := probeFLAC(path); err == nil {
			return info, nil
		}
	}
	if hasFFprobe() {
		return ffprobeAudioInfo(ctx, path)
	}
	return nil, ErrProbeUnsupported
}

/* ------------------------------------------------------------------ MP3 ---- */

const (
	mpegV25       = 0 // 2.5
	mpegVReserved = 1
	mpegV2        = 2
	mpegV1        = 3

	layerReserved = 0
	layer3        = 1
	layer2        = 2
	layer1        = 3
)

// Bitrate tables in kbps, indexed by [version][layer][bitrate_index].
// Index 0 = "free" (variable), index 15 = "bad". Both resolve to 0 here so
// a lookup against them is caught by the zero-check below.
var bitrateTable = [4][4][16]int{
	{ // MPEG-2.5
		{},
		{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0},      // L3
		{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0},      // L2
		{0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0}, // L1
	},
	{}, // reserved
	{ // MPEG-2
		{},
		{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0},
		{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0},
		{0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0},
	},
	{ // MPEG-1
		{},
		{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0},     // L3
		{0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0},    // L2
		{0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0}, // L1
	},
}

var sampleRateTable = [4][4]int{
	{11025, 12000, 8000, 0},  // MPEG-2.5
	{},                       // reserved
	{22050, 24000, 16000, 0}, // MPEG-2
	{44100, 48000, 32000, 0}, // MPEG-1
}

// Samples produced per decoded frame, indexed by [version][layer].
var samplesPerFrame = [4][4]int{
	{0, 576, 1152, 384},  // MPEG-2.5
	{},                   // reserved
	{0, 576, 1152, 384},  // MPEG-2
	{0, 1152, 1152, 384}, // MPEG-1
}

type mpegFrame struct {
	version    int
	layer      int
	bitrate    int // bits per second
	sampleRate int
	channels   int
	padding    bool
}

func parseFrameHeader(b []byte) *mpegFrame {
	if len(b) < 4 {
		return nil
	}
	// 11-bit frame sync.
	if b[0] != 0xFF || (b[1]&0xE0) != 0xE0 {
		return nil
	}
	v := int((b[1] >> 3) & 0x03)
	l := int((b[1] >> 1) & 0x03)
	if v == mpegVReserved || l == layerReserved {
		return nil
	}
	brIdx := int(b[2] >> 4)
	srIdx := int((b[2] >> 2) & 0x03)
	pad := b[2]&0x02 != 0
	chMode := int((b[3] >> 6) & 0x03)

	br := bitrateTable[v][l][brIdx]
	sr := sampleRateTable[v][srIdx]
	if br == 0 || sr == 0 {
		return nil
	}
	channels := 2
	if chMode == 3 {
		channels = 1
	}
	return &mpegFrame{
		version:    v,
		layer:      l,
		bitrate:    br * 1000,
		sampleRate: sr,
		channels:   channels,
		padding:    pad,
	}
}

// frameLength returns the full on-disk size of this MPEG frame in bytes.
func (h *mpegFrame) frameLength() int {
	pad := 0
	if h.padding {
		pad = 1
	}
	switch h.layer {
	case layer1:
		return (12*h.bitrate/h.sampleRate + pad) * 4
	case layer2:
		return 144*h.bitrate/h.sampleRate + pad
	case layer3:
		if h.version == mpegV1 {
			return 144*h.bitrate/h.sampleRate + pad
		}
		return 72*h.bitrate/h.sampleRate + pad
	}
	return 0
}

// findFrameSync scans for the first valid MPEG frame header in b. Returns
// -1 when none is found.
func findFrameSync(b []byte) int {
	for i := 0; i+4 <= len(b); i++ {
		if b[i] != 0xFF || (b[i+1]&0xE0) != 0xE0 {
			continue
		}
		if parseFrameHeader(b[i:]) != nil {
			return i
		}
	}
	return -1
}

// findXingOrVBRI searches the first frame's payload for a LAME-style Xing/Info
// tag or a Fraunhofer VBRI tag. Returns (frames, bytes, ok). Either field may
// be 0 if the corresponding flag bit was not set.
func findXingOrVBRI(frame []byte) (frames int, totalBytes int, ok bool) {
	for i := 0; i+8 <= len(frame); i++ {
		tag := frame[i : i+4]
		if bytes.Equal(tag, []byte("Xing")) || bytes.Equal(tag, []byte("Info")) {
			if i+8 > len(frame) {
				return 0, 0, false
			}
			flags := binary.BigEndian.Uint32(frame[i+4 : i+8])
			off := i + 8
			if flags&0x01 != 0 && off+4 <= len(frame) {
				frames = int(binary.BigEndian.Uint32(frame[off : off+4]))
				off += 4
			}
			if flags&0x02 != 0 && off+4 <= len(frame) {
				totalBytes = int(binary.BigEndian.Uint32(frame[off : off+4]))
			}
			return frames, totalBytes, true
		}
		if bytes.Equal(tag, []byte("VBRI")) {
			// VBRI header layout after the 4-byte magic:
			//   version(2) delay(2) quality(2) bytes(4) frames(4) ...
			if i+18 > len(frame) {
				return 0, 0, false
			}
			totalBytes = int(binary.BigEndian.Uint32(frame[i+10 : i+14]))
			frames = int(binary.BigEndian.Uint32(frame[i+14 : i+18]))
			return frames, totalBytes, true
		}
	}
	return 0, 0, false
}

func probeMP3(path string) (*AudioInfo, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := info.Size()
	start, end, err := mp3AudioBounds(f, size)
	if err != nil {
		return nil, err
	}

	// Read a buffer large enough to span the first frame (up to a few KB)
	// plus a little slack. 8KB covers every realistic configuration up to
	// 320 kbps at 32 kHz.
	bufSize := min(int64(8*1024), end-start)
	buf := make([]byte, bufSize)
	if _, err := f.ReadAt(buf, start); err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}

	syncOff := findFrameSync(buf)
	if syncOff < 0 {
		return nil, fmt.Errorf("no MPEG frame sync in first %d bytes", bufSize)
	}
	h := parseFrameHeader(buf[syncOff:])
	if h == nil {
		return nil, fmt.Errorf("invalid MPEG frame header")
	}

	// Limit the Xing search to this frame's declared length; beyond that
	// the bytes belong to the next frame and won't contain a header tag.
	frameEnd := min(syncOff+h.frameLength(), len(buf))
	out := &AudioInfo{
		SampleRate: h.sampleRate,
		Channels:   h.channels,
	}

	if xingFrames, xingBytes, ok := findXingOrVBRI(buf[syncOff:frameEnd]); ok && xingFrames > 0 {
		// Accurate VBR/CBR path: duration = frames × samples_per_frame / sample_rate.
		spf := samplesPerFrame[h.version][h.layer]
		if spf == 0 {
			spf = 1152
		}
		durMS := int64(xingFrames) * int64(spf) * 1000 / int64(h.sampleRate)
		out.DurationMS = int(durMS)
		if xingBytes > 0 && durMS > 0 {
			out.Bitrate = int(int64(xingBytes) * 8 * 1000 / durMS)
		} else {
			out.Bitrate = h.bitrate
		}
		return out, nil
	}

	// No Xing/VBRI — assume CBR and derive duration from the audio-byte range.
	audioBytes := end - start - int64(syncOff)
	if h.bitrate > 0 && audioBytes > 0 {
		out.DurationMS = int(audioBytes * 8 * 1000 / int64(h.bitrate))
	}
	out.Bitrate = h.bitrate
	return out, nil
}

/* ------------------------------------------------------------------ FLAC --- */

func probeFLAC(path string) (*AudioInfo, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	// Tolerate a leading ID3v2 (off-spec but seen in the wild).
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
		return nil, err
	}
	if !bytes.Equal(magic, []byte("fLaC")) {
		return nil, fmt.Errorf("missing fLaC magic at offset %d", off)
	}
	off += 4

	// First metadata block must be STREAMINFO (type 0, body size ≥ 34).
	blockHdr := make([]byte, 4)
	if _, err := f.ReadAt(blockHdr, off); err != nil {
		return nil, err
	}
	if blockHdr[0]&0x7F != 0 {
		return nil, fmt.Errorf("first FLAC metadata block is not STREAMINFO")
	}
	off += 4

	body := make([]byte, 34)
	if _, err := f.ReadAt(body, off); err != nil {
		return nil, err
	}

	// STREAMINFO packed fields at bytes 10..17:
	//   20 bits sample rate | 3 bits (channels-1) | 5 bits (bps-1) | 36 bits total_samples
	sampleRate := (int(body[10]) << 12) | (int(body[11]) << 4) | (int(body[12]) >> 4)
	channels := int((body[12]>>1)&0x07) + 1
	totalSamples := (int64(body[13]&0x0F) << 32) |
		(int64(body[14]) << 24) |
		(int64(body[15]) << 16) |
		(int64(body[16]) << 8) |
		int64(body[17])

	out := &AudioInfo{
		SampleRate: sampleRate,
		Channels:   channels,
	}
	if sampleRate > 0 && totalSamples > 0 {
		out.DurationMS = int(totalSamples * 1000 / int64(sampleRate))
	}
	// Approximate bitrate from the audio payload size (whole file minus
	// what we've already walked past; metadata chain isn't re-summed).
	if stat, err := f.Stat(); err == nil && out.DurationMS > 0 {
		audioBytes := stat.Size() - off
		if audioBytes > 0 {
			out.Bitrate = int(audioBytes * 8 * 1000 / int64(out.DurationMS))
		}
	}
	return out, nil
}

/* ------------------------------------------------------------- ffprobe ----- */

var (
	ffprobeOnce    sync.Once
	ffprobePresent bool
)

const ffprobeTimeout = 20 * time.Second

func hasFFprobe() bool {
	ffprobeOnce.Do(func() {
		_, err := exec.LookPath("ffprobe")
		ffprobePresent = err == nil
	})
	return ffprobePresent
}

// ffprobeAudioInfo shells out to ffprobe once to pull duration + nominal
// format info in a single subprocess. Used as a fallback for formats our
// in-process parsers don't cover, and as a last-ditch retry when a native
// parse fails on a damaged file.
func ffprobeAudioInfo(parent context.Context, path string) (*AudioInfo, error) {
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, ffprobeTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-select_streams", "a:0",
		"-show_entries", "format=duration:stream=bit_rate,sample_rate,channels",
		"-of", "json",
		path,
	)
	out := &boundedBytes{max: subprocessOutLimit}
	stderr := &lastBytes{max: subprocessErrTail}
	cmd.Stdout = out
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("ffprobe: %w", ctx.Err())
		}
		return nil, fmt.Errorf("ffprobe: %w (stderr tail=%s)", err, strings.TrimSpace(stderr.String()))
	}
	if out.Truncated() {
		return nil, fmt.Errorf("ffprobe output exceeded %d bytes", subprocessOutLimit)
	}
	var parsed struct {
		Streams []struct {
			BitRate    string `json:"bit_rate"`
			SampleRate string `json:"sample_rate"`
			Channels   int    `json:"channels"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(out.Bytes(), &parsed); err != nil {
		return nil, fmt.Errorf("ffprobe json: %w", err)
	}
	info := &AudioInfo{}
	if dur, err := strconv.ParseFloat(parsed.Format.Duration, 64); err == nil && dur > 0 {
		info.DurationMS = int(dur * 1000)
	}
	if len(parsed.Streams) > 0 {
		st := parsed.Streams[0]
		if n, err := strconv.Atoi(st.BitRate); err == nil {
			info.Bitrate = n
		}
		if n, err := strconv.Atoi(st.SampleRate); err == nil {
			info.SampleRate = n
		}
		info.Channels = st.Channels
	}
	return info, nil
}
