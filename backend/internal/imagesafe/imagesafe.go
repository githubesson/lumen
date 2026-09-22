// Package imagesafe decodes untrusted images with a pixel budget. Formats like
// PNG declare their dimensions up front and the stdlib decoders allocate the
// full raster before reading pixel data, so a few MB of compressed zeros that
// claim 60000x60000 pixels would otherwise allocate tens of GB and OOM the
// process.
package imagesafe

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"io"
)

// MaxPixels caps width*height for any decoded image. 50 MP covers phone
// camera photos (8000x6000) and every realistic cover; a decoded RGBA raster
// at this size is ~200 MB.
const MaxPixels = 50_000_000

var ErrTooLarge = errors.New("image dimensions too large")

// CheckConfig reads only the image header and rejects images that are empty
// or exceed MaxPixels.
func CheckConfig(cfg image.Config) error {
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return fmt.Errorf("invalid image dimensions %dx%d", cfg.Width, cfg.Height)
	}
	if int64(cfg.Width)*int64(cfg.Height) > MaxPixels {
		return fmt.Errorf("%w: %dx%d", ErrTooLarge, cfg.Width, cfg.Height)
	}
	return nil
}

// DecodeConfig returns the image header after validating its dimensions.
func DecodeConfig(r io.Reader) (image.Config, string, error) {
	cfg, format, err := image.DecodeConfig(r)
	if err != nil {
		return image.Config{}, "", err
	}
	if err := CheckConfig(cfg); err != nil {
		return image.Config{}, "", err
	}
	return cfg, format, nil
}

// Decode is a drop-in replacement for image.Decode that validates the header
// before allocating the raster. The header bytes consumed by DecodeConfig are
// replayed, so r does not need to be seekable.
func Decode(r io.Reader) (image.Image, string, error) {
	var header bytes.Buffer
	if _, _, err := DecodeConfig(io.TeeReader(r, &header)); err != nil {
		return nil, "", err
	}
	return image.Decode(io.MultiReader(&header, r))
}
