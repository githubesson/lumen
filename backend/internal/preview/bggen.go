package preview

// This file holds the cover-art background generator: a small k-means
// palette extractor plus the radial/ellipse compositing and HSV/blur passes
// that paint the story-card background. Split out of builder.go.

import (
	"image"
	"image/color"
	"math"
	"sort"
	"strconv"

	xdraw "golang.org/x/image/draw"
)

const bgGenDominantAchromaticArea = 0.28

type bgGenCluster struct {
	rgb   rgbf
	area  float64
	sat   float64
	lum   float64
	hue   float64
	value float64
	score float64
}

func drawBGGenBackground(dst *image.RGBA, cover image.Image, seed uint32) {
	bounds := dst.Bounds()
	w := bounds.Dx()
	h := bounds.Dy()
	colors, neutrals, darks := bgGenExtractPalette(cover, 12)
	if len(colors) == 0 {
		drawStoryGradientBackground(dst, Input{TrackID: strconv.FormatUint(uint64(seed), 10)})
		return
	}

	primary, accent, secondary, neutral, hasNeutral, dark := bgGenChooseRoles(colors, neutrals, darks)

	primaryColor := bgGenAdjustColor(primary.rgb, 1.08, 0.88)
	accentColor := bgGenAdjustColor(accent.rgb, 1.06, 0.90)
	secondaryColor := bgGenAdjustColor(secondary.rgb, 1.02, 0.82)
	darkColor := bgGenAdjustColor(dark.rgb, 0.95, 0.48)
	var neutralColor rgbf
	if hasNeutral {
		neutralColor = bgGenSoftenNeutral(neutral.rgb)
	} else {
		sum := rgbf{}
		count := min(4, len(colors))
		for i := 0; i < count; i++ {
			sum.r += colors[i].rgb.r
			sum.g += colors[i].rgb.g
			sum.b += colors[i].rgb.b
		}
		avg := rgbf{sum.r / float64(count), sum.g / float64(count), sum.b / float64(count)}
		lum := bgGenLuma(avg) * 255
		neutralColor = rgbf{
			r: math.Max(130, math.Min(205, lum)),
			g: math.Max(130, math.Min(205, lum)),
			b: math.Max(130, math.Min(205, lum)),
		}
	}
	baseColor := rgbf{
		r: primaryColor.r*0.36 + secondaryColor.r*0.22 + darkColor.r*0.42,
		g: primaryColor.g*0.36 + secondaryColor.g*0.22 + darkColor.g*0.42,
		b: primaryColor.b*0.36 + secondaryColor.b*0.22 + darkColor.b*0.42,
	}

	buf := make([]rgbf, w*h)
	for i := range buf {
		buf[i] = baseColor
	}

	bgGenCompositeRadial(buf, w, h, int(float64(w)*-0.14), int(float64(h)*0.20), int(float64(max(w, h))*0.88), 0.86, 1.55, primaryColor)
	bgGenCompositeRadial(buf, w, h, int(float64(w)*1.06), int(float64(h)*0.92), int(float64(max(w, h))*0.84), 0.66, 1.60, primaryColor)
	bgGenCompositeRadial(buf, w, h, int(float64(w)*1.04), int(float64(h)*0.02), int(float64(max(w, h))*0.78), 0.78, 1.50, accentColor)
	bgGenCompositeRadial(buf, w, h, int(float64(w)*-0.10), int(float64(h)*0.98), int(float64(max(w, h))*0.74), 0.46, 1.65, secondaryColor)
	bgGenCompositeRadial(buf, w, h, int(float64(w)*0.52), int(float64(h)*0.50), int(float64(max(w, h))*1.02), 0.26, 1.35, mixRGB(secondaryColor, accentColor, 0.45, 1))

	if hasNeutral && neutral.area > 0.015 {
		neutralStrength := math.Min(0.68, 0.36+neutral.area*3.5)
		bgGenCompositeEllipse(buf, w, h, int(float64(w)*0.76), int(float64(h)*0.42), int(float64(w)*0.62), int(float64(h)*0.24), neutralStrength, 1.15, neutralColor)
		bgGenCompositeEllipse(buf, w, h, int(float64(w)*0.62), int(float64(h)*0.55), int(float64(w)*0.65), int(float64(h)*0.24), neutralStrength*0.55, 1.25, neutralColor)
	}

	bgGenBoxBlur(buf, w, h, 26, 3)
	for i, c := range buf {
		c = bgGenEnhance(c, 1.13, 1.09, 0.93)
		x := i % w
		y := i / w
		dx := (float64(x) - float64(w)/2) / float64(w)
		dy := (float64(y) - float64(h)/2) / float64(h)
		dist := math.Sqrt(dx*dx + dy*dy)
		mask := math.Pow(clamp01((dist-0.13)/0.58), 1.75) * 105 / 255
		c = mixRGB(c, rgbf{}, mask, 1)
		c = bgGenCompositeOne(c, rgbf{255, 255, 255}, bgGenEllipseAlpha(x, y, int(float64(w)*0.50), int(float64(h)*0.48), int(float64(w)*0.36), int(float64(h)*0.18), 0.045, 1.6))
		n := bgGenNormalNoise(x, y, seed)
		dst.SetRGBA(bounds.Min.X+x, bounds.Min.Y+y, color.RGBA{
			R: uint8(clamp255(c.r + n)),
			G: uint8(clamp255(c.g + n)),
			B: uint8(clamp255(c.b + n)),
			A: 255,
		})
	}
}

func bgGenExtractPalette(src image.Image, k int) ([]bgGenCluster, []bgGenCluster, []bgGenCluster) {
	pixels := bgGenThumbnailPixels(src, 260)
	if len(pixels) == 0 {
		return nil, nil, nil
	}
	colorPixels := make([]rgbf, 0, len(pixels))
	neutralPixels := make([]rgbf, 0, len(pixels)/2)
	darkPixels := make([]rgbf, 0, len(pixels)/2)
	for _, px := range pixels {
		lum := bgGenLuma(px)
		sat := bgGenSaturation(px)
		if lum > 0.05 && lum < 0.96 && sat > 0.14 {
			colorPixels = append(colorPixels, px)
		}
		if lum > 0.36 && sat < 0.38 {
			neutralPixels = append(neutralPixels, px)
		}
		if lum < 0.36 {
			darkPixels = append(darkPixels, px)
		}
	}
	if len(colorPixels) < 100 {
		colorPixels = pixels
	}
	colors := bgGenExtractClusters(colorPixels, k, 7)
	neutrals := bgGenExtractClusters(neutralPixels, 6, 7)
	darks := bgGenExtractClusters(darkPixels, 6, 7)
	bgGenScaleClusterAreas(colors, float64(len(colorPixels))/float64(len(pixels)))
	bgGenScaleClusterAreas(neutrals, float64(len(neutralPixels))/float64(len(pixels)))
	bgGenScaleClusterAreas(darks, float64(len(darkPixels))/float64(len(pixels)))
	for i := range colors {
		c := &colors[i]
		c.score = c.area*1.35 + c.sat*1.65 + (1.0-math.Abs(c.lum-0.50))*0.85
	}
	for i := range neutrals {
		c := &neutrals[i]
		c.score = c.area*1.5 + (1.0-c.sat)*1.2 + (1.0-math.Abs(c.lum-0.68))*1.35
	}
	for i := range darks {
		c := &darks[i]
		c.score = c.area*1.4 + (1.0-math.Abs(c.lum-0.22))*1.2 + c.sat*0.25
	}
	bgGenSortClusters(colors)
	bgGenSortClusters(neutrals)
	bgGenSortClusters(darks)
	colors = bgGenPromoteDominantAchromatic(colors, neutrals, darks)
	return colors, neutrals, darks
}

func bgGenScaleClusterAreas(clusters []bgGenCluster, scale float64) {
	for i := range clusters {
		clusters[i].area *= scale
	}
}

func bgGenPromoteDominantAchromatic(colors, neutrals, darks []bgGenCluster) []bgGenCluster {
	for _, candidates := range [][]bgGenCluster{neutrals, darks} {
		for _, c := range candidates {
			if c.area < bgGenDominantAchromaticArea || bgGenSimilarCluster(colors, c) {
				continue
			}
			c.score = math.Max(c.score, c.area*4.5+(1.0-c.sat)*0.8+(1.0-math.Abs(c.lum-0.50))*0.45)
			colors = append(colors, c)
		}
	}
	bgGenSortClusters(colors)
	return colors
}

func bgGenSimilarCluster(clusters []bgGenCluster, c bgGenCluster) bool {
	for _, existing := range clusters {
		if bgGenRGBDist2(existing.rgb, c.rgb) < 144 && math.Abs(existing.lum-c.lum) < 0.08 {
			return true
		}
	}
	return false
}

func bgGenThumbnailPixels(src image.Image, maxSide int) []rgbf {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return nil
	}
	scale := math.Min(1, float64(maxSide)/float64(max(w, h)))
	tw := max(1, int(math.Round(float64(w)*scale)))
	th := max(1, int(math.Round(float64(h)*scale)))
	dst := image.NewRGBA(image.Rect(0, 0, tw, th))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, b, xdraw.Src, nil)
	pixels := make([]rgbf, 0, tw*th)
	for y := 0; y < th; y++ {
		for x := 0; x < tw; x++ {
			p := dst.RGBAAt(x, y)
			pixels = append(pixels, rgbf{float64(p.R), float64(p.G), float64(p.B)})
		}
	}
	return pixels
}

func bgGenExtractClusters(pixels []rgbf, k int, randomState uint32) []bgGenCluster {
	if len(pixels) == 0 {
		return nil
	}
	if k > len(pixels) {
		k = len(pixels)
	}
	centers := bgGenInitialCenters(pixels, k, randomState)
	labels := make([]int, len(pixels))
	for iter := 0; iter < 100; iter++ {
		changed := false
		for i, px := range pixels {
			best := 0
			bestDist := bgGenRGBDist2(px, centers[0])
			for j := 1; j < k; j++ {
				if d := bgGenRGBDist2(px, centers[j]); d < bestDist {
					best = j
					bestDist = d
				}
			}
			if iter == 0 || labels[i] != best {
				changed = true
			}
			labels[i] = best
		}
		sums := make([]rgbf, k)
		counts := make([]int, k)
		for i, label := range labels {
			sums[label].r += pixels[i].r
			sums[label].g += pixels[i].g
			sums[label].b += pixels[i].b
			counts[label]++
		}
		for i := 0; i < k; i++ {
			if counts[i] == 0 {
				continue
			}
			centers[i] = rgbf{sums[i].r / float64(counts[i]), sums[i].g / float64(counts[i]), sums[i].b / float64(counts[i])}
		}
		if !changed {
			break
		}
	}
	clusters := make([]bgGenCluster, 0, k)
	counts := make([]int, k)
	for _, label := range labels {
		counts[label]++
	}
	for i, center := range centers {
		if counts[i] == 0 {
			continue
		}
		rgb := rgbf{math.Max(0, math.Min(255, center.r)), math.Max(0, math.Min(255, center.g)), math.Max(0, math.Min(255, center.b))}
		h, _, v := bgGenRGBToHSV(rgb)
		clusters = append(clusters, bgGenCluster{
			rgb:   rgbf{float64(uint8(rgb.r)), float64(uint8(rgb.g)), float64(uint8(rgb.b))},
			area:  float64(counts[i]) / float64(len(pixels)),
			sat:   bgGenSaturation(rgb),
			lum:   bgGenLuma(rgb),
			hue:   h,
			value: v,
		})
	}
	return clusters
}

func bgGenInitialCenters(pixels []rgbf, k int, seed uint32) []rgbf {
	centers := make([]rgbf, 0, k)
	rng := bgGenRNG{state: uint64(seed)}
	centers = append(centers, pixels[rng.Intn(len(pixels))])
	for len(centers) < k {
		distances := make([]float64, len(pixels))
		total := 0.0
		for i, px := range pixels {
			best := bgGenRGBDist2(px, centers[0])
			for _, c := range centers[1:] {
				if d := bgGenRGBDist2(px, c); d < best {
					best = d
				}
			}
			distances[i] = best
			total += best
		}
		if total <= 0 {
			centers = append(centers, pixels[len(centers)%len(pixels)])
			continue
		}
		pick := rng.Float64() * total
		acc := 0.0
		idx := len(pixels) - 1
		for i, d := range distances {
			acc += d
			if acc >= pick {
				idx = i
				break
			}
		}
		centers = append(centers, pixels[idx])
	}
	return centers
}

type bgGenRNG struct{ state uint64 }

func (r *bgGenRNG) next() uint64 {
	r.state = r.state*6364136223846793005 + 1442695040888963407
	return r.state
}

func (r *bgGenRNG) Intn(n int) int {
	if n <= 1 {
		return 0
	}
	return int(r.next() % uint64(n))
}

func (r *bgGenRNG) Float64() float64 {
	return float64(r.next()>>11) / (1 << 53)
}

func bgGenSortClusters(clusters []bgGenCluster) {
	sort.SliceStable(clusters, func(i, j int) bool { return clusters[i].score > clusters[j].score })
}

func bgGenChooseRoles(colors, neutrals, darks []bgGenCluster) (bgGenCluster, bgGenCluster, bgGenCluster, bgGenCluster, bool, bgGenCluster) {
	primary := colors[0]
	accent := primary
	if len(colors) > 1 {
		bestScore := math.Inf(-1)
		for _, c := range colors[1:] {
			diff := bgGenHueDistance(primary.hue, c.hue)
			diversityBonus := 0.0
			if diff > 0.18 {
				diversityBonus += 1.5
			}
			if diff > 0.28 {
				diversityBonus += 1.0
			}
			score := c.score*0.75 + diff*3.2 + c.sat*0.9 + c.area*0.4 + diversityBonus
			if score > bestScore {
				accent = c
				bestScore = score
			}
		}
	}

	secondary := accent
	bestSecondaryScore := math.Inf(-1)
	for _, c := range colors {
		if bgGenSameCluster(c, primary) || bgGenSameCluster(c, accent) {
			continue
		}
		diffPrimary := bgGenHueDistance(primary.hue, c.hue)
		diffAccent := bgGenHueDistance(accent.hue, c.hue)
		minDiff := math.Min(diffPrimary, diffAccent)
		diversityBonus := 0.0
		if minDiff > 0.12 {
			diversityBonus += 1.0
		}
		if minDiff > 0.22 {
			diversityBonus += 0.8
		}
		score := c.score*0.75 + minDiff*2.0 + c.sat*0.7 + diversityBonus
		if score > bestSecondaryScore {
			secondary = c
			bestSecondaryScore = score
		}
	}

	neutral := bgGenCluster{}
	hasNeutral := len(neutrals) > 0
	if hasNeutral {
		neutral = neutrals[0]
		bestNeutralScore := neutral.lum*1.7 + (1.0-neutral.sat)*0.8 + neutral.area*0.5
		for _, c := range neutrals[1:] {
			score := c.lum*1.7 + (1.0-c.sat)*0.8 + c.area*0.5
			if score > bestNeutralScore {
				neutral = c
				bestNeutralScore = score
			}
		}
	}

	dark := colors[0]
	if len(darks) > 0 {
		dark = darks[0]
	} else {
		for _, c := range colors[1:] {
			if c.lum < dark.lum {
				dark = c
			}
		}
	}
	return primary, accent, secondary, neutral, hasNeutral, dark
}

func bgGenSameCluster(a, b bgGenCluster) bool {
	return a.rgb == b.rgb && a.area == b.area && a.hue == b.hue
}

func bgGenHueDistance(a, b float64) float64 {
	d := math.Abs(a - b)
	return math.Min(d, 1.0-d)
}

func bgGenAdjustColor(rgb rgbf, saturationBoost, brightness float64) rgbf {
	h, s, v := bgGenRGBToHSV(rgb)
	s = clamp01(s * saturationBoost)
	v = clamp01(v * brightness)
	return bgGenHSVToRGB(h, s, v)
}

func bgGenSoftenNeutral(rgb rgbf) rgbf {
	c := rgbf{
		r: math.Max(105, math.Min(220, rgb.r)),
		g: math.Max(105, math.Min(220, rgb.g)),
		b: math.Max(105, math.Min(220, rgb.b)),
	}
	lum := bgGenLuma(c) * 255
	return rgbf{
		r: c.r*0.45 + lum*0.55,
		g: c.g*0.45 + lum*0.55,
		b: c.b*0.45 + lum*0.55,
	}
}

func bgGenCompositeRadial(buf []rgbf, w, h, cx, cy, radius int, opacity, power float64, c rgbf) {
	if radius <= 0 {
		return
	}
	r := float64(radius)
	for y := 0; y < h; y++ {
		dy := float64(y - cy)
		for x := 0; x < w; x++ {
			dx := float64(x - cx)
			alpha := math.Max(0, 1-math.Sqrt(dx*dx+dy*dy)/r)
			if alpha <= 0 {
				continue
			}
			alpha = math.Pow(alpha, power) * opacity
			i := y*w + x
			buf[i] = mixRGB(buf[i], c, alpha, 1)
		}
	}
}

func bgGenCompositeEllipse(buf []rgbf, w, h, cx, cy, rx, ry int, opacity, power float64, c rgbf) {
	if rx <= 0 || ry <= 0 {
		return
	}
	frx := float64(rx)
	fry := float64(ry)
	for y := 0; y < h; y++ {
		dy := float64(y-cy) / fry
		for x := 0; x < w; x++ {
			dx := float64(x-cx) / frx
			alpha := math.Max(0, 1-math.Sqrt(dx*dx+dy*dy))
			if alpha <= 0 {
				continue
			}
			alpha = math.Pow(alpha, power) * opacity
			i := y*w + x
			buf[i] = mixRGB(buf[i], c, alpha, 1)
		}
	}
}

func bgGenCompositeOne(base, c rgbf, alpha float64) rgbf {
	if alpha <= 0 {
		return base
	}
	return mixRGB(base, c, alpha, 1)
}

func bgGenEllipseAlpha(x, y, cx, cy, rx, ry int, opacity, power float64) float64 {
	if rx <= 0 || ry <= 0 {
		return 0
	}
	dx := float64(x-cx) / float64(rx)
	dy := float64(y-cy) / float64(ry)
	alpha := math.Max(0, 1-math.Sqrt(dx*dx+dy*dy))
	if alpha <= 0 {
		return 0
	}
	return math.Pow(alpha, power) * opacity
}

func bgGenBoxBlur(buf []rgbf, w, h, radius, passes int) {
	if radius <= 0 || passes <= 0 {
		return
	}
	tmp := make([]rgbf, len(buf))
	for p := 0; p < passes; p++ {
		for y := 0; y < h; y++ {
			var sum rgbf
			for x := -radius; x <= radius; x++ {
				c := buf[y*w+min(w-1, max(0, x))]
				sum.r += c.r
				sum.g += c.g
				sum.b += c.b
			}
			for x := 0; x < w; x++ {
				n := float64(radius*2 + 1)
				tmp[y*w+x] = rgbf{sum.r / n, sum.g / n, sum.b / n}
				remove := buf[y*w+max(0, x-radius)]
				add := buf[y*w+min(w-1, x+radius+1)]
				sum.r += add.r - remove.r
				sum.g += add.g - remove.g
				sum.b += add.b - remove.b
			}
		}
		for x := 0; x < w; x++ {
			var sum rgbf
			for y := -radius; y <= radius; y++ {
				c := tmp[min(h-1, max(0, y))*w+x]
				sum.r += c.r
				sum.g += c.g
				sum.b += c.b
			}
			for y := 0; y < h; y++ {
				n := float64(radius*2 + 1)
				buf[y*w+x] = rgbf{sum.r / n, sum.g / n, sum.b / n}
				remove := tmp[max(0, y-radius)*w+x]
				add := tmp[min(h-1, y+radius+1)*w+x]
				sum.r += add.r - remove.r
				sum.g += add.g - remove.g
				sum.b += add.b - remove.b
			}
		}
	}
}

func bgGenEnhance(c rgbf, saturation, contrast, brightness float64) rgbf {
	h, s, v := bgGenRGBToHSV(c)
	c = bgGenHSVToRGB(h, clamp01(s*saturation), v)
	c.r = (c.r-128)*contrast + 128
	c.g = (c.g-128)*contrast + 128
	c.b = (c.b-128)*contrast + 128
	return rgbf{c.r * brightness, c.g * brightness, c.b * brightness}
}

func bgGenNormalNoise(x, y int, seed uint32) float64 {
	u1 := (hashNoise(x, y, seed) + 1) / 2
	u2 := (hashNoise(x+7919, y-104729, seed^0x9e3779b9) + 1) / 2
	u1 = math.Max(1e-9, math.Min(1, u1))
	return math.Sqrt(-2*math.Log(u1)) * math.Cos(2*math.Pi*u2)
}

func bgGenLuma(rgb rgbf) float64 {
	return 0.2126*(rgb.r/255) + 0.7152*(rgb.g/255) + 0.0722*(rgb.b/255)
}

func bgGenSaturation(rgb rgbf) float64 {
	r := rgb.r / 255
	g := rgb.g / 255
	b := rgb.b / 255
	mx := math.Max(r, math.Max(g, b))
	mn := math.Min(r, math.Min(g, b))
	if mx == 0 {
		return 0
	}
	return (mx - mn) / mx
}

func bgGenRGBToHSV(rgb rgbf) (float64, float64, float64) {
	r := rgb.r / 255
	g := rgb.g / 255
	b := rgb.b / 255
	mx := math.Max(r, math.Max(g, b))
	mn := math.Min(r, math.Min(g, b))
	d := mx - mn
	h := 0.0
	if d != 0 {
		switch mx {
		case r:
			h = math.Mod((g-b)/d, 6)
		case g:
			h = (b-r)/d + 2
		default:
			h = (r-g)/d + 4
		}
		h /= 6
		if h < 0 {
			h += 1
		}
	}
	s := 0.0
	if mx != 0 {
		s = d / mx
	}
	return h, s, mx
}

func bgGenHSVToRGB(h, s, v float64) rgbf {
	h = math.Mod(h, 1)
	if h < 0 {
		h += 1
	}
	i := int(math.Floor(h * 6))
	f := h*6 - float64(i)
	p := v * (1 - s)
	q := v * (1 - f*s)
	t := v * (1 - (1-f)*s)
	var r, g, b float64
	switch i % 6 {
	case 0:
		r, g, b = v, t, p
	case 1:
		r, g, b = q, v, p
	case 2:
		r, g, b = p, v, t
	case 3:
		r, g, b = p, q, v
	case 4:
		r, g, b = t, p, v
	default:
		r, g, b = v, p, q
	}
	return rgbf{r * 255, g * 255, b * 255}
}

func bgGenRGBDist2(a, b rgbf) float64 {
	dr := a.r - b.r
	dg := a.g - b.g
	db := a.b - b.b
	return dr*dr + dg*dg + db*db
}
