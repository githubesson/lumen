package handlers

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"math"

	xdraw "golang.org/x/image/draw"

	"github.com/githubesson/lumen/internal/colormath"
	"github.com/githubesson/lumen/internal/library"
)

type accentOKLCH struct {
	l float64
	c float64
	h float64
}

// accentColorForTrack picks the accent from local cover storage when the
// track has a stored cover, falling back to the remote CDN artwork for
// materialized streamed (TIDAL) rows.
func (h *Share) accentColorForTrack(ctx context.Context, t *library.TrackDetail) string {
	if c := h.accentColorForCover(ctx, t.CoverArtPath); c != "" {
		return c
	}
	if t.CoverURL == "" {
		return ""
	}
	u, err := allowedRemoteCoverURL(t.CoverURL)
	if err != nil {
		return ""
	}
	data, _, err := coverCache.fetchCached(u)
	if err != nil {
		return ""
	}
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return ""
	}
	raw, ok := extractAccentFromImage(src)
	if !ok {
		return ""
	}
	return oklchToHex(clampAccentDark(raw))
}

func (h *Share) accentColorForCover(ctx context.Context, coverKey string) string {
	if coverKey == "" || h.Storage == nil {
		return ""
	}
	body, _, err := h.Storage.Get(ctx, coverKey)
	if err != nil {
		return ""
	}
	defer body.Close()

	src, _, err := image.Decode(body)
	if err != nil {
		return ""
	}
	raw, ok := extractAccentFromImage(src)
	if !ok {
		return ""
	}
	accent := clampAccentDark(raw)
	return oklchToHex(accent)
}

func extractAccentFromImage(src image.Image) (accentOKLCH, bool) {
	const size = 32
	dst := image.NewRGBA(image.Rect(0, 0, size, size))
	xdraw.ApproxBiLinear.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Src, nil)

	var best accentOKLCH
	var fallback accentOKLCH
	bestScore := math.Inf(-1)
	fallbackScore := math.Inf(-1)
	hasBest := false
	hasFallback := false

	for y := 0; y < size; y++ {
		row := y * dst.Stride
		for x := 0; x < size; x++ {
			i := row + x*4
			a := dst.Pix[i+3]
			if a < 200 {
				continue
			}
			c := rgbToOklch(float64(dst.Pix[i]), float64(dst.Pix[i+1]), float64(dst.Pix[i+2]))
			if c.l < 0.15 || c.l > 0.92 {
				continue
			}
			score := c.c * (1 - math.Abs(c.l-0.55))
			if c.c >= 0.08 && score > bestScore {
				bestScore = score
				best = c
				hasBest = true
			}
			if score > fallbackScore {
				fallbackScore = score
				fallback = c
				hasFallback = true
			}
		}
	}
	if hasBest {
		return best, true
	}
	return fallback, hasFallback
}

func rgbToOklch(r, g, b float64) accentOKLCH {
	c := colormath.FromSRGB(r, g, b)
	return accentOKLCH{l: c.L, c: c.C, h: c.H}
}

func clampAccentDark(raw accentOKLCH) accentOKLCH {
	const targetL = 0.72
	const targetC = 0.17
	l := math.Max(targetL-0.04, math.Min(targetL+0.04, raw.l))
	c := math.Max(0.08, math.Min(targetC+0.04, raw.c))
	return accentOKLCH{l: l, c: c, h: raw.h}
}

func oklchToHex(c accentOKLCH) string {
	rgb := colormath.ToSRGB(colormath.OKLCH{L: c.l, C: c.c, H: c.h})
	return fmt.Sprintf("#%02x%02x%02x", byte(math.Round(rgb.R)), byte(math.Round(rgb.G)), byte(math.Round(rgb.B)))
}
