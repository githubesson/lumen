package handlers

import (
	"context"
	"fmt"
	"image"
	"math"

	xdraw "golang.org/x/image/draw"
)

type accentOKLCH struct {
	l float64
	c float64
	h float64
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
	lr := srgbToLinear(r)
	lg := srgbToLinear(g)
	lb := srgbToLinear(b)
	l_ := math.Cbrt(0.4122214708*lr + 0.5363325363*lg + 0.0514459929*lb)
	m_ := math.Cbrt(0.2119034982*lr + 0.6806995451*lg + 0.1073969566*lb)
	s_ := math.Cbrt(0.0883024619*lr + 0.2817188376*lg + 0.6299787005*lb)
	L := 0.2104542553*l_ + 0.7936177850*m_ - 0.0040720468*s_
	a := 1.9779984951*l_ - 2.4285922050*m_ + 0.4505937099*s_
	bb := 0.0259040371*l_ + 0.7827717662*m_ - 0.8086757660*s_
	C := math.Hypot(a, bb)
	H := math.Atan2(bb, a) * 180 / math.Pi
	if H < 0 {
		H += 360
	}
	return accentOKLCH{l: L, c: C, h: H}
}

func srgbToLinear(v float64) float64 {
	s := v / 255
	if s <= 0.04045 {
		return s / 12.92
	}
	return math.Pow((s+0.055)/1.055, 2.4)
}

func clampAccentDark(raw accentOKLCH) accentOKLCH {
	const targetL = 0.72
	const targetC = 0.17
	l := math.Max(targetL-0.04, math.Min(targetL+0.04, raw.l))
	c := math.Max(0.08, math.Min(targetC+0.04, raw.c))
	return accentOKLCH{l: l, c: c, h: raw.h}
}

func oklchToHex(c accentOKLCH) string {
	h := c.h * math.Pi / 180
	a := c.c * math.Cos(h)
	b := c.c * math.Sin(h)

	l_ := c.l + 0.3963377774*a + 0.2158037573*b
	m_ := c.l - 0.1055613458*a - 0.0638541728*b
	s_ := c.l - 0.0894841775*a - 1.2914855480*b

	l := l_ * l_ * l_
	m := m_ * m_ * m_
	s := s_ * s_ * s_

	r := linearToSRGB(4.0767416621*l - 3.3077115913*m + 0.2309699292*s)
	g := linearToSRGB(-1.2684380046*l + 2.6097574011*m - 0.3413193965*s)
	bl := linearToSRGB(-0.0041960863*l - 0.7034186147*m + 1.7076147010*s)

	return fmt.Sprintf("#%02x%02x%02x", byte(math.Round(r*255)), byte(math.Round(g*255)), byte(math.Round(bl*255)))
}

func linearToSRGB(v float64) float64 {
	v = math.Max(0, math.Min(1, v))
	if v <= 0.0031308 {
		return 12.92 * v
	}
	return 1.055*math.Pow(v, 1/2.4) - 0.055
}
