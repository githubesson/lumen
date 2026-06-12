package preview

import "math"

// This file holds the value-clamping helpers and the OKLCH ↔ sRGB color math
// used by the story-card background generator. Split out of builder.go to keep
// the color science in one place. The rgbf and storyOKLCH types are declared in
// builder.go (same package).

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
	lr := srgbToStoryLinear(r)
	lg := srgbToStoryLinear(g)
	lb := srgbToStoryLinear(b)
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
	return storyOKLCH{l: L, c: C, h: H}
}

func oklchToRGBF(c storyOKLCH) rgbf {
	h := c.h * math.Pi / 180
	a := c.c * math.Cos(h)
	b := c.c * math.Sin(h)

	l_ := c.l + 0.3963377774*a + 0.2158037573*b
	m_ := c.l - 0.1055613458*a - 0.0638541728*b
	s_ := c.l - 0.0894841775*a - 1.2914855480*b

	l := l_ * l_ * l_
	m := m_ * m_ * m_
	s := s_ * s_ * s_

	return rgbf{
		r: storyLinearToSRGB(4.0767416621*l-3.3077115913*m+0.2309699292*s) * 255,
		g: storyLinearToSRGB(-1.2684380046*l+2.6097574011*m-0.3413193965*s) * 255,
		b: storyLinearToSRGB(-0.0041960863*l-0.7034186147*m+1.7076147010*s) * 255,
	}
}

func srgbToStoryLinear(v float64) float64 {
	s := v / 255
	if s <= 0.04045 {
		return s / 12.92
	}
	return math.Pow((s+0.055)/1.055, 2.4)
}

func storyLinearToSRGB(v float64) float64 {
	v = clamp01(v)
	if v <= 0.0031308 {
		return 12.92 * v
	}
	return 1.055*math.Pow(v, 1/2.4) - 0.055
}

func storyColorDistance(a, b storyOKLCH) float64 {
	return storyHueDistance(a.h, b.h)/180 + math.Abs(a.l-b.l)*1.15 + math.Abs(a.c-b.c)*0.9
}

func storyHueDistance(a, b float64) float64 {
	diff := math.Abs(math.Mod(a-b+540, 360) - 180)
	return math.Min(180, diff)
}
