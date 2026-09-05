package preview

import (
	"math"

	"github.com/githubesson/lumen/internal/colormath"
)

// Rendering-specific clamping and distance helpers. Color conversion delegates
// to colormath; rgbf and storyOKLCH remain private rendering types.

// clampF constrains v to the inclusive [lo, hi] range.
func clampF(v, lo, hi float64) float64 {
	return math.Max(lo, math.Min(hi, v))
}

// clamp01 constrains v to the inclusive [0, 1] range.
func clamp01(v float64) float64 {
	return clampF(v, 0, 1)
}

func clamp255(v float64) int {
	return int(math.Round(clampF(v, 0, 255)))
}

func rgbToStoryOKLCH(r, g, b float64) storyOKLCH {
	c := colormath.FromSRGB(r, g, b)
	return storyOKLCH{l: c.L, c: c.C, h: c.H}
}

func oklchToRGBF(c storyOKLCH) rgbf {
	rgb := colormath.ToSRGB(colormath.OKLCH{L: c.l, C: c.c, H: c.h})
	return rgbf{r: rgb.R, g: rgb.G, b: rgb.B}
}

func storyColorDistance(a, b storyOKLCH) float64 {
	return storyHueDistance(a.h, b.h)/180 + math.Abs(a.l-b.l)*1.15 + math.Abs(a.c-b.c)*0.9
}

func storyHueDistance(a, b float64) float64 {
	diff := math.Abs(math.Mod(a-b+540, 360) - 180)
	return math.Min(180, diff)
}
