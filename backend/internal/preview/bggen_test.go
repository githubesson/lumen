package preview

import (
	"image"
	"image/color"
	"testing"
)

func TestBGGenPalettePromotesDominantBlack(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 100, 100))
	fillRect(img, image.Rect(0, 0, 100, 100), color.RGBA{R: 2, G: 2, B: 2, A: 255})
	fillRect(img, image.Rect(0, 0, 20, 100), color.RGBA{R: 220, G: 24, B: 24, A: 255})

	colors, neutrals, darks := bgGenExtractPalette(img, 4)
	primary, _, _, _, _, _ := bgGenChooseRoles(colors, neutrals, darks)

	if primary.lum > 0.08 {
		t.Fatalf("expected dominant black cover area to be eligible as primary, got rgb=%+v lum=%.3f area=%.3f", primary.rgb, primary.lum, primary.area)
	}
	if primary.area < 0.70 {
		t.Fatalf("expected primary area to reflect total cover coverage, got %.3f", primary.area)
	}
}

func TestBGGenPalettePromotesDominantWhite(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 100, 100))
	fillRect(img, image.Rect(0, 0, 100, 100), color.RGBA{R: 252, G: 252, B: 252, A: 255})
	fillRect(img, image.Rect(0, 0, 25, 100), color.RGBA{R: 23, G: 76, B: 215, A: 255})

	colors, neutrals, darks := bgGenExtractPalette(img, 4)
	primary, _, _, _, _, _ := bgGenChooseRoles(colors, neutrals, darks)

	if primary.lum < 0.88 || primary.sat > 0.12 {
		t.Fatalf("expected dominant white cover area to be eligible as primary, got rgb=%+v lum=%.3f sat=%.3f area=%.3f", primary.rgb, primary.lum, primary.sat, primary.area)
	}
	if primary.area < 0.65 {
		t.Fatalf("expected primary area to reflect total cover coverage, got %.3f", primary.area)
	}
}

func TestBGGenPaletteKeepsMinorBlackOutOfPrimary(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 100, 100))
	fillRect(img, image.Rect(0, 0, 100, 100), color.RGBA{R: 220, G: 24, B: 24, A: 255})
	fillRect(img, image.Rect(0, 0, 20, 100), color.RGBA{R: 2, G: 2, B: 2, A: 255})

	colors, neutrals, darks := bgGenExtractPalette(img, 4)
	primary, _, _, _, _, _ := bgGenChooseRoles(colors, neutrals, darks)

	if primary.lum < 0.20 {
		t.Fatalf("expected minor black cover area not to displace dominant chromatic color, got rgb=%+v lum=%.3f area=%.3f", primary.rgb, primary.lum, primary.area)
	}
}

func fillRect(img *image.RGBA, rect image.Rectangle, c color.RGBA) {
	for y := rect.Min.Y; y < rect.Max.Y; y++ {
		for x := rect.Min.X; x < rect.Max.X; x++ {
			img.SetRGBA(x, y, c)
		}
	}
}
