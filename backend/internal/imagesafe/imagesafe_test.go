package imagesafe

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"strings"
	"testing"
	"time"
)

func TestDecodeAcceptsNormalImage(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 4, 3))
	src.Set(1, 1, color.RGBA{R: 255, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, src); err != nil {
		t.Fatal(err)
	}
	img, release, err := Decode(context.Background(), bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	release()
	if img.Bounds().Dx() != 4 || img.Bounds().Dy() != 3 {
		t.Fatalf("got bounds=%v", img.Bounds())
	}
}

func TestDecodeRejectsOversizedHeaderWithoutAllocating(t *testing.T) {
	data := pngHeaderOnly(60000, 60000, 8, 0, false)
	_, _, err := Decode(context.Background(), bytes.NewReader(data))
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("Decode err = %v, want ErrTooLarge", err)
	}
}

// The pixel cap alone let every layout through at 50 MP; what a decode
// costs depends on the layout, so the limit is on the estimated memory.
func TestDecodeConfigLimitsDecodeMemoryByLayout(t *testing.T) {
	for _, tc := range []struct {
		name string
		data []byte
		ok   bool
	}{
		{"8-bit RGBA PNG, 49 MP", pngHeaderOnly(7000, 7000, 8, 6, false), true},
		{"8-bit gray PNG, 49 MP (tRNS can widen it to NRGBA)", pngHeaderOnly(7000, 7000, 8, 0, false), true},
		{"16-bit RGBA PNG, 36 MP", pngHeaderOnly(6000, 6000, 16, 6, false), false},
		{"16-bit RGBA PNG, 25 MP", pngHeaderOnly(5000, 5000, 16, 6, false), true},
		{"interlaced 8-bit RGBA PNG, 49 MP", pngHeaderOnly(7000, 7000, 8, 6, true), false},
		{"phone photo: 24 MP progressive 4:2:0 JPEG", jpegHeaderOnly(5712, 4284, true, 0x22, 0x11, 0x11), true},
		{"48 MP baseline 4:2:0 JPEG", jpegHeaderOnly(8064, 6048, false, 0x22, 0x11, 0x11), true},
		{"49 MP baseline 4:4:4 JPEG", jpegHeaderOnly(7000, 7000, false, 0x11, 0x11, 0x11), true},
		{"49 MP progressive 4:4:4 JPEG", jpegHeaderOnly(7000, 7000, true, 0x11, 0x11, 0x11), false},
		{"36 MP CMYK JPEG", jpegHeaderOnly(6000, 6000, false, 0x11, 0x11, 0x11, 0x11), false},
	} {
		_, _, err := DecodeConfig(bytes.NewReader(tc.data))
		if tc.ok && err != nil {
			t.Errorf("%s: refused: %v", tc.name, err)
		}
		if !tc.ok && !errors.Is(err, ErrTooLarge) {
			t.Errorf("%s: err = %v, want ErrTooLarge", tc.name, err)
		}
	}
}

// The JPEG estimate follows the decoder's allocation exactly: one byte per
// sample, in MCU-padded planes sized by each component's sampling factors.
func TestJPEGEstimateMatchesDecoderPlanes(t *testing.T) {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 100, 80)), nil); err != nil {
		t.Fatal(err)
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	// 4:2:0 in 16x16 MCUs: luma 112x80, each chroma plane 56x40.
	want := int64(112*80 + 2*56*40)
	if got := decodeBytes(cfg, "jpeg", buf.Bytes()); got != want {
		t.Fatalf("baseline estimate = %d, want %d", got, want)
	}
	// Progressive keeps every coefficient as well: 4 bytes a sample.
	prog := bytes.Replace(buf.Bytes(), []byte{0xff, 0xc0}, []byte{0xff, 0xc2}, 1)
	if got := decodeBytes(cfg, "jpeg", prog); got != 5*want {
		t.Fatalf("progressive estimate = %d, want %d", got, 5*want)
	}
	// Without a frame header to read, the estimate must not come out lower.
	if got := decodeBytes(cfg, "jpeg", nil); got < 5*want {
		t.Fatalf("fallback estimate = %d, below the progressive %d", got, 5*want)
	}

	// Segments are skipped whole, as the decoder skips them, so a frame
	// header lookalike inside an APP1 (EXIF) payload is not the frame.
	fake := []byte{0xff, 0xc2, 0x00, 0x11, 8, 0, 80, 0, 100, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0}
	app1 := append([]byte{0xff, 0xe1, 0x00, byte(2 + len(fake))}, fake...)
	exif := append(append([]byte{0xff, 0xd8}, app1...), buf.Bytes()[2:]...)
	if _, err := jpeg.DecodeConfig(bytes.NewReader(exif)); err != nil {
		t.Fatal(err)
	}
	if got := decodeBytes(cfg, "jpeg", exif); got != want {
		t.Fatalf("estimate with an APP1 lookalike = %d, want %d", got, want)
	}
}

func TestWebPEstimateByChunkLayout(t *testing.T) {
	cfg := image.Config{ColorModel: color.YCbCrModel, Width: 100, Height: 100}
	lossy := []byte("RIFF\x00\x00\x00\x00WEBPVP8 ")
	extended := []byte("RIFF\x00\x00\x00\x00WEBPVP8X")
	if got := decodeBytes(cfg, "webp", lossy); got != 2*100*100 {
		t.Fatalf("simple lossy estimate = %d", got)
	}
	// An extended file may hold a lossless image or alpha plane whatever
	// its header's color model says.
	if got := decodeBytes(cfg, "webp", extended); got != 9*100*100 {
		t.Fatalf("extended estimate = %d", got)
	}
}

func TestDecodeWaitsForBudgetAndHonoursContext(t *testing.T) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 8, 8))); err != nil {
		t.Fatal(err)
	}
	if err := decodeSem.Acquire(context.Background(), decodeBudget); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, _, err := Decode(ctx, bytes.NewReader(buf.Bytes())); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Decode with the budget exhausted: err = %v, want DeadlineExceeded", err)
	}
	decodeSem.Release(decodeBudget)

	_, release, err := Decode(context.Background(), bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if decodeSem.TryAcquire(decodeBudget) {
		t.Fatal("the decoded image's share was not held")
	}
	release()
	release() // a second call must not release someone else's share
	if !decodeSem.TryAcquire(decodeBudget) {
		t.Fatal("release did not return the share")
	}
	decodeSem.Release(decodeBudget)
}

func init() {
	// A format whose decoder panics, as x/image's WebP decoder did on some
	// crafted files.
	image.RegisterFormat("panics", "PANICS", func(io.Reader) (image.Image, error) {
		panic("decoder bug")
	}, func(io.Reader) (image.Config, error) {
		return image.Config{ColorModel: color.RGBAModel, Width: 8, Height: 8}, nil
	})
}

func TestDecodeReturnsShareWhenDecoderPanics(t *testing.T) {
	func() {
		defer func() { _ = recover() }()
		_, _, _ = Decode(context.Background(), strings.NewReader("PANICS"))
		t.Fatal("decoder did not panic")
	}()
	if !decodeSem.TryAcquire(decodeBudget) {
		t.Fatal("a panicking decode kept its share of the budget")
	}
	decodeSem.Release(decodeBudget)
}

// pngHeaderOnly returns a PNG signature plus an IHDR chunk claiming w x h
// pixels of the given bit depth and color type. It is enough for
// DecodeConfig; there is no pixel data.
func pngHeaderOnly(w, h uint32, depth, colorType byte, interlaced bool) []byte {
	var buf bytes.Buffer
	buf.WriteString("\x89PNG\r\n\x1a\n")
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], w)
	binary.BigEndian.PutUint32(ihdr[4:], h)
	ihdr[8] = depth
	ihdr[9] = colorType
	if interlaced {
		ihdr[12] = 1
	}
	chunk := append([]byte("IHDR"), ihdr...)
	_ = binary.Write(&buf, binary.BigEndian, uint32(len(ihdr)))
	buf.Write(chunk)
	_ = binary.Write(&buf, binary.BigEndian, crc32.ChecksumIEEE(chunk))
	return buf.Bytes()
}

// jpegHeaderOnly returns SOI, a JFIF APP0 segment and a frame header for
// w x h with one component per sampling-factor byte. JFIF makes DecodeConfig
// stop at the frame header; there is no scan data.
func jpegHeaderOnly(w, h int, progressive bool, factors ...byte) []byte {
	b := []byte{0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 'J', 'F', 'I', 'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0}
	sof := byte(0xc0)
	if progressive {
		sof = 0xc2
	}
	n := 8 + 3*len(factors)
	b = append(b, 0xff, sof, byte(n>>8), byte(n), 8, byte(h>>8), byte(h), byte(w>>8), byte(w), byte(len(factors)))
	for i, f := range factors {
		b = append(b, byte(i+1), f, 0)
	}
	return b
}
