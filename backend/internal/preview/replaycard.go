package preview

// This file renders the Replay share card: a 1080x1920 "Cover hero" PNG with
// the #1 cover as a blurred backdrop, the crisp cover centered, and the
// runner-up tracks on a translucent panel. Served by /api/stats/replay/image.

import (
	"errors"
	"fmt"
	"image"
	"image/color"
	"strconv"
	"strings"

	xdraw "golang.org/x/image/draw"
	"golang.org/x/image/font"
)

// ReplayCardTrack is one ranked entry on the share card. CoverPath may be
// empty; the renderer falls back to a neutral placeholder tile.
type ReplayCardTrack struct {
	Title     string
	Artist    string
	Plays     int
	CoverPath string
}

// ReplayCardInput carries everything the card shows. Tracks are in rank
// order; the first is the hero, the next four become panel rows.
type ReplayCardInput struct {
	PeriodTitle    string // e.g. "This year · 2026"
	TotalPlays     int
	ListeningLabel string // preformatted, e.g. "11d 6h"
	Tracks         []ReplayCardTrack
}

const (
	replayCardW   = 1080
	replayCardH   = 1920
	replayCardPad = 80
)

// BuildReplayCard renders the share card. It fails only on font loading —
// missing covers degrade to placeholders, never to an error.
func BuildReplayCard(in ReplayCardInput) (*image.RGBA, error) {
	if len(in.Tracks) == 0 {
		return nil, errors.New("replay card: no tracks")
	}

	eyebrowFace, err := storyFontFace(replayRegularFonts, 30)
	if err != nil {
		return nil, fmt.Errorf("replay card fonts: %w", err)
	}
	smallFace, err := storyFontFace(replayRegularFonts, 24)
	if err != nil {
		return nil, fmt.Errorf("replay card fonts: %w", err)
	}
	titleFace, err := storyFontFace(replayDisplayFonts, 72)
	if err != nil {
		return nil, fmt.Errorf("replay card fonts: %w", err)
	}
	rowTitleFace, err := storyFontFace(replaySemiboldFonts, 30)
	if err != nil {
		return nil, fmt.Errorf("replay card fonts: %w", err)
	}
	brandFace, err := storyFontFace(replaySemiboldFonts, 24)
	if err != nil {
		return nil, fmt.Errorf("replay card fonts: %w", err)
	}

	img := image.NewRGBA(image.Rect(0, 0, replayCardW, replayCardH))

	hero := in.Tracks[0]
	heroTitle := defaultString(stripReplayEmoji(hero.Title), "Untitled track")
	heroArtist := defaultString(stripReplayEmoji(hero.Artist), "Unknown artist")
	heroCover, heroErr := decodeImageFile(hero.CoverPath)
	if heroErr == nil {
		drawReplayBlurredBackdrop(img, heroCover)
	} else {
		drawStoryGradientBackground(img, Input{TrackID: "replay:" + hero.Title})
	}
	applyReplayScrim(img)

	white70 := whiteAlpha(0.70)
	white75 := whiteAlpha(0.75)
	white60 := whiteAlpha(0.60)
	white80 := whiteAlpha(0.80)
	white := color.RGBA{255, 255, 255, 255}

	contentW := replayCardW - 2*replayCardPad
	y := replayCardPad

	eyebrow := "Replay · " + defaultString(stripReplayEmoji(in.PeriodTitle), "All time")
	drawReplayCenteredText(img, eyebrowFace, ellipsizeText(eyebrowFace, eyebrow, contentW), y, white70)
	y += faceHeight(eyebrowFace) + 64

	// Hero cover, 560px centered with 24px radius.
	const heroSize = 560
	heroX := (replayCardW - heroSize) / 2
	if heroErr == nil {
		drawRoundedImage(img, heroCover, heroX, y, heroSize, heroSize, 24)
	} else {
		drawRoundedRect(img, heroX, y, heroSize, heroSize, 24, color.RGBA{44, 44, 46, 255})
	}
	y += heroSize + 56

	drawReplayCenteredText(img, smallFace, "Most played", y, white70)
	y += faceHeight(smallFace) + 12

	for _, line := range wrapReplayText(titleFace, heroTitle, contentW, 2) {
		drawReplayCenteredText(img, titleFace, line, y, white)
		y += faceHeight(titleFace)
	}
	y += 16

	heroLine := heroArtist + " · " + formatReplayCount(hero.Plays) + " " + pluralPlays(hero.Plays)
	drawReplayCenteredText(img, eyebrowFace, ellipsizeText(eyebrowFace, heroLine, contentW), y, white75)
	y += faceHeight(eyebrowFace) + 64

	// Runner-up panel: ranks 2-5 on a translucent rounded surface.
	rows := in.Tracks[1:]
	if len(rows) > 4 {
		rows = rows[:4]
	}
	if len(rows) > 0 {
		const (
			panelPad = 40
			rowH     = 80
			rowGap   = 28
			thumb    = 80
			rankW    = 40
			itemGap  = 28
		)
		panelX := replayCardPad
		panelH := 2*panelPad + len(rows)*rowH + (len(rows)-1)*(2*rowGap+1)
		drawRoundedRect(img, panelX, y, contentW, panelH, 24, color.RGBA{255, 255, 255, 26})

		rowY := y + panelPad
		for i, rt := range rows {
			if i > 0 {
				dividerY := rowY - rowGap - 1
				drawRoundedRect(img, panelX+panelPad, dividerY, contentW-2*panelPad, 1, 0, color.RGBA{255, 255, 255, 26})
			}

			rank := strconv.Itoa(i + 2)
			rankX := panelX + panelPad + (rankW-textWidth(smallFace, rank))/2
			drawTextTop(img, smallFace, rank, rankX, rowY+(rowH-faceHeight(smallFace))/2, white60)

			thumbX := panelX + panelPad + rankW + itemGap
			if cover, err := decodeImageFile(rt.CoverPath); err == nil {
				drawRoundedImage(img, cover, thumbX, rowY, thumb, thumb, 8)
			} else {
				drawRoundedRect(img, thumbX, rowY, thumb, thumb, 8, color.RGBA{58, 58, 60, 255})
			}

			plays := formatReplayCount(rt.Plays)
			playsX := panelX + contentW - panelPad - textWidth(smallFace, plays)
			drawTextTop(img, smallFace, plays, playsX, rowY+(rowH-faceHeight(smallFace))/2, white60)

			textX := thumbX + thumb + itemGap
			textMaxW := playsX - itemGap - textX
			titleH := faceHeight(rowTitleFace)
			subH := faceHeight(smallFace)
			textTop := rowY + (rowH-titleH-subH-4)/2
			rowTitle := defaultString(stripReplayEmoji(rt.Title), "Untitled track")
			rowArtist := defaultString(stripReplayEmoji(rt.Artist), "Unknown artist")
			drawTextTop(img, rowTitleFace, ellipsizeText(rowTitleFace, rowTitle, textMaxW), textX, textTop, white)
			drawTextTop(img, smallFace, ellipsizeText(smallFace, rowArtist, textMaxW), textX, textTop+titleH+4, white60)

			rowY += rowH + 2*rowGap + 1
		}
	}

	// Footer: brand on the left, totals on the right.
	footerH := max(faceHeight(brandFace), 36)
	footerY := replayCardH - replayCardPad - footerH
	// drawLumenWaveform blends with straight alpha, unlike the premultiplied
	// colors the font drawer takes.
	drawLumenWaveform(img, replayCardPad, footerY+6, 1, color.RGBA{255, 255, 255, 204})
	drawTextTop(img, brandFace, "Lumen", replayCardPad+54, footerY+(footerH-faceHeight(brandFace))/2, white80)

	stats := formatReplayCount(in.TotalPlays) + " " + pluralPlays(in.TotalPlays)
	if in.ListeningLabel != "" {
		stats += " · " + in.ListeningLabel + " listened"
	}
	statsX := replayCardW - replayCardPad - textWidth(smallFace, stats)
	drawTextTop(img, smallFace, stats, statsX, footerY+(footerH-faceHeight(smallFace))/2, white70)

	return img, nil
}

var (
	replayRegularFonts = []string{
		"SF-Pro-Text-Regular.otf",
		"SF-Pro-Display-Regular.otf",
		"DejaVuSans.ttf",
	}
	replaySemiboldFonts = []string{
		"SF-Pro-Text-Semibold.otf",
		"SF-Pro-Display-Semibold.otf",
		"DejaVuSans-Bold.ttf",
	}
	replayDisplayFonts = []string{
		"SF-Pro-Display-Bold.otf",
		"SF-Pro-Text-Bold.otf",
		"DejaVuSans-Bold.ttf",
	}
)

// drawReplayBlurredBackdrop paints the cover across the full 9:16 canvas,
// heavily blurred and dimmed — the CSS equivalent of `object-cover blur-2xl
// opacity-80` over black. Blur runs on a small intermediate so cost stays
// flat regardless of cover resolution.
func drawReplayBlurredBackdrop(dst *image.RGBA, cover image.Image) {
	const (
		sw = 135
		sh = 240
	)
	crop := centerAspectCrop(cover.Bounds(), 9.0/16.0)
	small := image.NewRGBA(image.Rect(0, 0, sw, sh))
	xdraw.CatmullRom.Scale(small, small.Bounds(), cover, crop, xdraw.Src, nil)

	buf := make([]rgbf, sw*sh)
	for y := 0; y < sh; y++ {
		for x := 0; x < sw; x++ {
			p := small.RGBAAt(x, y)
			buf[y*sw+x] = rgbf{float64(p.R) * 0.8, float64(p.G) * 0.8, float64(p.B) * 0.8}
		}
	}
	bgGenBoxBlur(buf, sw, sh, 8, 3)
	for y := 0; y < sh; y++ {
		for x := 0; x < sw; x++ {
			c := buf[y*sw+x]
			small.SetRGBA(x, y, color.RGBA{
				R: uint8(clamp255(c.r)),
				G: uint8(clamp255(c.g)),
				B: uint8(clamp255(c.b)),
				A: 255,
			})
		}
	}
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), small, small.Bounds(), xdraw.Src, nil)
}

// applyReplayScrim darkens the backdrop with a vertical gradient (40% black
// at the top through 55% mid to 85% at the bottom) so text stays readable on
// any artwork.
func applyReplayScrim(dst *image.RGBA) {
	bounds := dst.Bounds()
	w := bounds.Dx()
	h := bounds.Dy()
	for y := 0; y < h; y++ {
		t := float64(y) / float64(h-1)
		var a float64
		if t <= 0.5 {
			a = 0.40 + (0.55-0.40)*(t/0.5)
		} else {
			a = 0.55 + (0.85-0.55)*((t-0.5)/0.5)
		}
		keep := 1 - a
		for x := 0; x < w; x++ {
			p := dst.RGBAAt(bounds.Min.X+x, bounds.Min.Y+y)
			dst.SetRGBA(bounds.Min.X+x, bounds.Min.Y+y, color.RGBA{
				R: uint8(float64(p.R) * keep),
				G: uint8(float64(p.G) * keep),
				B: uint8(float64(p.B) * keep),
				A: 255,
			})
		}
	}
}

func drawReplayCenteredText(dst *image.RGBA, face font.Face, text string, y int, c color.RGBA) {
	x := (dst.Bounds().Dx() - textWidth(face, text)) / 2
	drawTextTop(dst, face, text, x, y, c)
}

func faceHeight(face font.Face) int {
	m := face.Metrics()
	return (m.Ascent + m.Descent).Ceil()
}

// whiteAlpha returns white at the given opacity as alpha-premultiplied RGBA,
// which is what font.Drawer expects from its source image.
func whiteAlpha(a float64) color.RGBA {
	v := uint8(255*a + 0.5)
	return color.RGBA{v, v, v, v}
}

// stripReplayEmoji removes emoji and pictographic symbols that the story
// fonts can't render (they come out as tofu boxes), then collapses any
// whitespace the removal left behind. Returns "" when nothing survives, so
// callers can fall through to their placeholder text.
func stripReplayEmoji(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if isReplayEmojiRune(r) {
			continue
		}
		b.WriteRune(r)
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

func isReplayEmojiRune(r rune) bool {
	switch {
	case r >= 0x1F000 && r <= 0x1FFFF: // emoji & pictographs (all plane-1 blocks)
		return true
	case r >= 0x2600 && r <= 0x27BF: // misc symbols + dingbats (☀…➿)
		return true
	case r >= 0x2B00 && r <= 0x2BFF: // arrows/stars used as emoji (⬆ ⭐)
		return true
	case r >= 0x2300 && r <= 0x23FF: // misc technical used as emoji (⌚ ⏰)
		return true
	case r >= 0xFE00 && r <= 0xFE0F: // variation selectors
		return true
	case r == 0x200D || r == 0x20E3: // ZWJ, combining keycap
		return true
	}
	return false
}

// wrapReplayText greedily word-wraps text into at most maxLines lines that
// each fit maxWidth; the final line is ellipsized when text remains.
func wrapReplayText(face font.Face, text string, maxWidth, maxLines int) []string {
	if maxLines <= 1 || textWidth(face, text) <= maxWidth {
		return []string{ellipsizeText(face, text, maxWidth)}
	}
	words := strings.Fields(text)
	lines := make([]string, 0, maxLines)
	cur := ""
	for i, word := range words {
		next := word
		if cur != "" {
			next = cur + " " + word
		}
		if cur != "" && textWidth(face, next) > maxWidth {
			lines = append(lines, cur)
			if len(lines) == maxLines-1 {
				rest := strings.Join(words[i:], " ")
				return append(lines, ellipsizeText(face, rest, maxWidth))
			}
			cur = word
			continue
		}
		cur = next
	}
	if cur != "" {
		lines = append(lines, ellipsizeText(face, cur, maxWidth))
	}
	return lines
}

func formatReplayCount(n int) string {
	s := strconv.Itoa(n)
	if n < 0 || len(s) <= 3 {
		return s
	}
	var out []byte
	for i, d := range []byte(s) {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, d)
	}
	return string(out)
}

func pluralPlays(n int) string {
	if n == 1 {
		return "play"
	}
	return "plays"
}
