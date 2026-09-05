// Package colormath provides shared sRGB (0–255) and OKLCH conversion.
package colormath

import "math"

type OKLCH struct{ L, C, H float64 }
type RGB struct{ R, G, B float64 }

// FromSRGB converts 0–255 channels to OKLCH with hue in degrees.
func FromSRGB(r, g, b float64) OKLCH {
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
	return OKLCH{L: L, C: C, H: H}
}

// ToSRGB converts OKLCH to floating-point 0–255 channels, clipping the gamut.
func ToSRGB(c OKLCH) RGB {
	h := c.H * math.Pi / 180
	a := c.C * math.Cos(h)
	b := c.C * math.Sin(h)

	l_ := c.L + 0.3963377774*a + 0.2158037573*b
	m_ := c.L - 0.1055613458*a - 0.0638541728*b
	s_ := c.L - 0.0894841775*a - 1.2914855480*b

	l := l_ * l_ * l_
	m := m_ * m_ * m_
	s := s_ * s_ * s_

	return RGB{
		R: linearToSRGB(4.0767416621*l-3.3077115913*m+0.2309699292*s) * 255,
		G: linearToSRGB(-1.2684380046*l+2.6097574011*m-0.3413193965*s) * 255,
		B: linearToSRGB(-0.0041960863*l-0.7034186147*m+1.7076147010*s) * 255,
	}
}

func srgbToLinear(v float64) float64 {
	s := v / 255
	if s <= 0.04045 {
		return s / 12.92
	}
	return math.Pow((s+0.055)/1.055, 2.4)
}

func linearToSRGB(v float64) float64 {
	v = math.Max(0, math.Min(1, v))
	if v <= 0.0031308 {
		return 12.92 * v
	}
	return 1.055*math.Pow(v, 1/2.4) - 0.055
}
