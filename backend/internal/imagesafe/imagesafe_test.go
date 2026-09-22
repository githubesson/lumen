package imagesafe

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func TestDecodeAcceptsNormalImage(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 4, 3))
	src.Set(1, 1, color.RGBA{R: 255, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, src); err != nil {
		t.Fatal(err)
	}
	img, format, err := Decode(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if format != "png" || img.Bounds().Dx() != 4 || img.Bounds().Dy() != 3 {
		t.Fatalf("got format=%q bounds=%v", format, img.Bounds())
	}
}

func TestDecodeRejectsOversizedHeaderWithoutAllocating(t *testing.T) {
	data := pngHeaderOnly(60000, 60000)
	_, _, err := Decode(bytes.NewReader(data))
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("Decode err = %v, want ErrTooLarge", err)
	}
}

// pngHeaderOnly returns a PNG signature plus an IHDR chunk claiming w x h
// grayscale pixels. It is enough for DecodeConfig; there is no pixel data.
func pngHeaderOnly(w, h uint32) []byte {
	var buf bytes.Buffer
	buf.WriteString("\x89PNG\r\n\x1a\n")
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], w)
	binary.BigEndian.PutUint32(ihdr[4:], h)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 0 // grayscale
	chunk := append([]byte("IHDR"), ihdr...)
	_ = binary.Write(&buf, binary.BigEndian, uint32(len(ihdr)))
	buf.Write(chunk)
	_ = binary.Write(&buf, binary.BigEndian, crc32.ChecksumIEEE(chunk))
	return buf.Bytes()
}
