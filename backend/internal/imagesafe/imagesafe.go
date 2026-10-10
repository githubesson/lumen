// Package imagesafe decodes untrusted images within memory bounds. Formats
// like PNG declare their dimensions up front and the stdlib decoders
// allocate the full raster before reading pixel data, so a few MB of
// compressed zeros that claim 60000x60000 pixels would otherwise allocate
// tens of GB and OOM the process. Each image is checked from its header
// alone, and decodes draw on one process-wide memory budget, so that many
// concurrent requests can't add up to the same thing.
package imagesafe

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"io"
	"sync"

	"golang.org/x/sync/semaphore"
)

// MaxPixels caps width*height for any decoded image. 50 MP covers phone
// camera photos uploaded as story backgrounds, including the 48-50 MP modes
// of current phones; covers are far smaller. It also bounds the CPU a caller
// spends scaling the raster.
const MaxPixels = 50_000_000

// MaxDecodeBytes caps the memory one decode may need (see decodeBytes). It
// admits a 50 MP 8-bit PNG and a 24 MP progressive phone JPEG, while a 16-bit
// PNG gets about 33 MP. It is half of decodeBudget, so two of the largest
// images can decode at once.
const MaxDecodeBytes = 256 << 20

// decodeBudget bounds the decode memory held by all callers at once. The
// backend container has 4 GB. Go's GC lets the heap grow to about twice what
// is live, so this much in rasters can cost about 1 GiB, which leaves the rest
// for ffmpeg renders, HLS segment buffers, multipart uploads and the cover
// cache.
const decodeBudget = 512 << 20

var decodeSem = semaphore.NewWeighted(decodeBudget)

var ErrTooLarge = errors.New("image too large to decode")

// DecodeConfig returns the image header after checking the image against
// MaxPixels and MaxDecodeBytes, so a caller can refuse an image before
// spending anything else on it.
func DecodeConfig(r io.Reader) (image.Config, string, error) {
	var header bytes.Buffer
	cfg, format, _, err := readHeader(r, &header)
	return cfg, format, err
}

// Decode decodes an untrusted image. It checks the header first, as
// DecodeConfig does, then waits (until ctx is done) for the image's share of
// the process-wide decode budget. The header bytes are replayed, so r does
// not need to be seekable.
//
// The share stays held until release is called, because the raster stays
// live while the caller scales or samples it: call release as soon as img is
// no longer needed, and before any slow work such as writing a response.
// release is never nil, and does nothing after an error or a first call.
//
// The share is an estimate of what the decoder itself allocates. Buffers a
// caller derives from img are not counted; the callers here only derive
// small, fixed-size ones (a thumbnail, a 1080x1920 frame).
func Decode(ctx context.Context, r io.Reader) (img image.Image, release func(), err error) {
	release = func() {}
	var header bytes.Buffer
	_, _, n, err := readHeader(r, &header)
	if err != nil {
		return nil, release, err
	}
	if err := decodeSem.Acquire(ctx, n); err != nil {
		return nil, release, err
	}
	held := sync.OnceFunc(func() { decodeSem.Release(n) })
	img, _, err = image.Decode(io.MultiReader(&header, r))
	if err != nil {
		held()
		return nil, release, err
	}
	return img, held, nil
}

// readHeader reads the image header from r, keeping the bytes it consumed in
// header, checks the limits, and returns the estimated decode memory.
func readHeader(r io.Reader, header *bytes.Buffer) (image.Config, string, int64, error) {
	cfg, format, err := image.DecodeConfig(io.TeeReader(r, header))
	if err != nil {
		return image.Config{}, "", 0, err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return image.Config{}, "", 0, fmt.Errorf("invalid image dimensions %dx%d", cfg.Width, cfg.Height)
	}
	if int64(cfg.Width)*int64(cfg.Height) > MaxPixels {
		return image.Config{}, "", 0, fmt.Errorf("%w: %dx%d", ErrTooLarge, cfg.Width, cfg.Height)
	}
	n := decodeBytes(cfg, format, header.Bytes())
	if n > MaxDecodeBytes {
		return image.Config{}, "", 0, fmt.Errorf("%w: %dx%d %s needs about %d MiB",
			ErrTooLarge, cfg.Width, cfg.Height, format, n>>20)
	}
	return cfg, format, n, nil
}

// decodeBytes estimates the memory the registered decoder allocates for an
// image: its raster in the decoder's own layout, plus the working buffers it
// fills on the way. Those count even when dropped before the decode ends,
// since garbage holds the heap until the next GC cycle. Measured against the
// decoders, JPEG estimates are exact and the others come within about 10%,
// the gap being per-block Huffman tables that scale with the compressed size
// rather than the pixels.
// header holds the bytes DecodeConfig read, which include the format's header
// chunks.
func decodeBytes(cfg image.Config, format string, header []byte) int64 {
	px := int64(cfg.Width) * int64(cfg.Height)
	switch format {
	case "jpeg":
		return jpegDecodeBytes(cfg, header)
	case "png":
		n := px * pngBytesPerPixel(cfg.ColorModel)
		// An interlaced (Adam7) image also decodes each of its seven passes
		// into an image of its own; together they are as large again.
		if len(header) > pngInterlaceOffset && header[pngInterlaceOffset] != 0 {
			n *= 2
		}
		return n
	case "webp":
		// A simple lossy file is a single VP8 frame: YCbCr 4:2:0 in 16x16
		// macroblocks. Any other layout may hold a lossless (VP8L) image, or
		// an alpha plane compressed the same way, which decodes to NRGBA (4
		// bytes a pixel) from a packed form (up to 2 more) when the
		// color-indexing transform bundles pixels. An alpha plane is then
		// copied out (1) beside the YCbCr frame (1.5).
		if len(header) >= 16 && string(header[12:16]) == "VP8 " {
			return px * 2
		}
		return px * 9
	}
	// A format with no model here is assumed to decode to the widest stdlib
	// layout, 16-bit RGBA.
	return px * 8
}

// pngInterlaceOffset is the interlace method's offset in a PNG: the 8-byte
// signature, the IHDR chunk's length and type, then width, height, bit depth,
// color type, compression and filter method. IHDR always comes first.
const pngInterlaceOffset = 28

// pngBytesPerPixel is the width of the raster the PNG decoder allocates. A
// tRNS chunk, which DecodeConfig stops before, widens 8-bit gray to NRGBA and
// 16-bit gray to NRGBA64, so gray is counted at those widths.
func pngBytesPerPixel(m color.Model) int64 {
	if _, ok := m.(color.Palette); ok {
		return 1
	}
	switch m {
	case color.Gray16Model, color.RGBA64Model, color.NRGBA64Model:
		return 8
	}
	return 4
}

// jpegDecodeBytes estimates the JPEG decoder's peak from the frame header.
// The decoder keeps one byte per sample for each component, padded to whole
// MCUs (1.5 bytes a pixel for 4:2:0 YCbCr, 4 for CMYK). A progressive file
// also keeps every DCT coefficient, 4 bytes a sample, until its last scan.
// RGB and CMYK files are then converted into a new 4-byte-per-pixel image
// while all of that is still held.
func jpegDecodeBytes(cfg image.Config, header []byte) int64 {
	samples, progressive, ok := jpegFrame(header, cfg)
	if !ok {
		// DecodeConfig read a frame header, so this shouldn't happen. If it
		// does, assume the most one could say: progressive, with four
		// full-size components padded to the largest MCU, 32 pixels.
		pad := func(n int) int64 { return int64(n+31) &^ 31 }
		samples, progressive = 4*pad(cfg.Width)*pad(cfg.Height), true
	}
	n := samples
	if progressive {
		n += 4 * samples
	}
	if cfg.ColorModel == color.RGBAModel || cfg.ColorModel == color.CMYKModel {
		n += 4 * int64(cfg.Width) * int64(cfg.Height)
	}
	return n
}

// jpegFrame walks the segments in b the way the decoder does and returns the
// number of samples the decoder allocates for the frame (SOF) header it finds,
// and whether the frame is progressive. ok is false when there is no frame
// header for cfg in b.
func jpegFrame(b []byte, cfg image.Config) (samples int64, progressive, ok bool) {
	if len(b) < 2 || b[0] != 0xff || b[1] != 0xd8 {
		return 0, false, false
	}
	for i := 2; ; {
		if i+2 > len(b) {
			return 0, false, false
		}
		// Like the decoder, skip stray bytes before a marker, "\xff\x00",
		// and any number of 0xff fill bytes.
		t0, t1 := b[i], b[i+1]
		i += 2
		for t0 != 0xff {
			if i >= len(b) {
				return 0, false, false
			}
			t0, t1 = t1, b[i]
			i++
		}
		marker := t1
		if marker == 0 {
			continue
		}
		for marker == 0xff {
			if i >= len(b) {
				return 0, false, false
			}
			marker = b[i]
			i++
		}
		switch {
		case marker == 0xd9 || marker == 0xda: // EOI or SOS before any frame
			return 0, false, false
		case 0xd0 <= marker && marker <= 0xd7: // RSTn, no length
			continue
		}
		if i+2 > len(b) {
			return 0, false, false
		}
		n := int(b[i])<<8 | int(b[i+1])
		if n < 2 || i+n > len(b) {
			return 0, false, false
		}
		seg := b[i+2 : i+n]
		i += n
		switch marker {
		case 0xc0, 0xc1, 0xc2: // the SOF types the decoder supports
			samples, ok = jpegFrameSamples(seg, cfg)
			return samples, marker == 0xc2, ok
		}
	}
}

// jpegFrameSamples counts the samples the decoder allocates for a frame
// header: precision, height, width and component count, then three bytes per
// component (id, sampling factors, quantization table).
func jpegFrameSamples(seg []byte, cfg image.Config) (int64, bool) {
	if len(seg) < 6 {
		return 0, false
	}
	height, width, nComp := int(seg[1])<<8|int(seg[2]), int(seg[3])<<8|int(seg[4]), int(seg[5])
	if width != cfg.Width || height != cfg.Height || nComp < 1 || len(seg) != 6+3*nComp {
		return 0, false
	}
	factors := func(c int) (int64, int64) {
		if nComp == 1 {
			// A lone component is decoded as 1x1 whatever it declares.
			return 1, 1
		}
		hv := seg[7+3*c]
		return int64(hv >> 4), int64(hv & 0x0f)
	}
	// MCUs are sized by the first component's factors, the largest: the
	// decoder refuses frames where they are not.
	h0, v0 := factors(0)
	if h0 == 0 || v0 == 0 {
		return 0, false
	}
	mxx := (int64(width) + 8*h0 - 1) / (8 * h0)
	myy := (int64(height) + 8*v0 - 1) / (8 * v0)
	var samples int64
	for c := range nComp {
		h, v := factors(c)
		samples += 64 * mxx * myy * h * v
	}
	return samples, true
}
