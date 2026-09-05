package colormath

import (
	"math"
	"testing"
)

func TestSRGBRedAndRoundTrips(t *testing.T) {
	red := FromSRGB(255, 0, 0)
	if math.Abs(red.L-0.62795536) > 1e-6 || math.Abs(red.C-0.25768331) > 1e-6 || math.Abs(red.H-29.233885) > 1e-5 {
		t.Fatalf("unexpected red coordinates: %+v", red)
	}
	for _, input := range []RGB{{0, 0, 0}, {255, 255, 255}, {255, 0, 0}, {0, 255, 0}, {0, 0, 255}, {63, 127, 201}} {
		got := ToSRGB(FromSRGB(input.R, input.G, input.B))
		if math.Abs(got.R-input.R) > 0.001 || math.Abs(got.G-input.G) > 0.001 || math.Abs(got.B-input.B) > 0.001 {
			t.Errorf("round trip %+v -> %+v", input, got)
		}
	}
}
