package preview

import "math"

// Rendering-specific clamping helpers.

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
