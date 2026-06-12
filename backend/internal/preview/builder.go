// Package preview builds 30-second MP4 snippets (album cover + audio slice)
// that Discord — and any chat app honoring og:video — can autoplay inline as
// link previews. Generation is lazy (first /api/public/previews/... request
// builds the file and caches it on disk), so tracks that are never shared
// cost nothing.
package preview

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"image"
	"image/color"
	_ "image/jpeg"
	"image/png"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	xdraw "golang.org/x/image/draw"
	"golang.org/x/image/font"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
	_ "golang.org/x/image/webp"
	"golang.org/x/sync/semaphore"
	"golang.org/x/sync/singleflight"
)

// PreviewDuration is the length of the generated snippet. Long enough that
// the embed feels like a real preview, short enough to keep the MP4 tiny
// and well under Discord's inline video size limits.
const PreviewDuration = 30 * time.Second

// buildTimeout bounds a single ffmpeg invocation. Static-image + 30s audio
// transcodes are fast; anything past this almost certainly indicates the
// audio file is unreadable or ffmpeg is stuck.
const buildTimeout = 45 * time.Second

const defaultFFmpegConcurrency = 2

var (
	defaultFFmpegSemOnce sync.Once
	defaultFFmpegSem     *semaphore.Weighted
)

// Builder owns the preview cache directory + an in-flight dedupe group so
// concurrent requests for the same (track, startSec) only run ffmpeg once.
type Builder struct {
	// CacheDir is where generated MP4s live. Created on first use.
	CacheDir string
	// FFmpegPath is the path/name of the ffmpeg binary. Empty = "ffmpeg"
	// on $PATH (the backend container installs ffmpeg via apk).
	FFmpegPath string

	group singleflight.Group

	mu       sync.Mutex
	ensureOK bool // cached "CacheDir exists" to avoid mkdir on every call
}

// Input describes a single preview build request.
type Input struct {
	TrackID   string // used to name the cache file
	AudioPath string // absolute path to the source audio file on disk
	CoverPath string // absolute path to the album cover image on disk; empty → no image (audio-only MP4, still works)
	StartSec  int    // seconds into the audio to start the 30s slice
	Title     string // optional; used by story renders
	Artist    string // optional; used by story renders
}

// Crop is a normalized source-image rectangle. Values are fractions of the
// source image dimensions, where (0, 0, 1, 1) means the full image.
type Crop struct {
	X      float64
	Y      float64
	Width  float64
	Height float64
}

// CustomBackground describes a caller-supplied image to use as the 9:16 story
// video background.
type CustomBackground struct {
	ImagePath string
	Crop      Crop
}

// EnsureBuilt builds the preview MP4 for `in` if it isn't cached, and
// returns the path to the cached file. Safe for concurrent calls with the
// same input — only one ffmpeg process runs.
func (b *Builder) EnsureBuilt(ctx context.Context, in Input) (string, error) {
	return b.ensureBuilt(ctx, in, "preview", b.cachePath(in.TrackID, in.StartSec), b.run)
}

// EnsureStoryBuilt builds the Instagram-story-shaped MP4 for `in` if it isn't
// cached. The story variant is 1080x1920 with a textured color background,
// artwork card, title/artist text, and the same 30s audio window.
func (b *Builder) EnsureStoryBuilt(ctx context.Context, in Input) (string, error) {
	return b.ensureBuilt(ctx, in, "story-v12", b.storyCachePath(in.TrackID, in.StartSec), b.runStory)
}

// EnsureStoryBackgroundBuilt builds a background-only Instagram story MP4.
// The mobile app can pass this as backgroundVideo and render the sticker
// separately so text is not baked into the compressed video.
func (b *Builder) EnsureStoryBackgroundBuilt(ctx context.Context, in Input) (string, error) {
	return b.ensureBuilt(ctx, in, "story-bg-v4", b.storyBackgroundCachePath(in.TrackID, in.StartSec), b.runStoryBackground)
}

// BuildCustomStoryBackground builds a one-off background-only Instagram story
// MP4 from a caller-supplied image. The caller owns outPath and can remove it
// after streaming; this deliberately does not cache personal photo uploads.
func (b *Builder) BuildCustomStoryBackground(ctx context.Context, in Input, bg CustomBackground, outPath string) error {
	if b == nil || b.CacheDir == "" {
		return errors.New("preview builder not configured")
	}
	if in.TrackID == "" {
		return errors.New("track id required")
	}
	if in.AudioPath == "" {
		return errors.New("audio path required")
	}
	if bg.ImagePath == "" {
		return errors.New("background image required")
	}
	if outPath == "" {
		return errors.New("output path required")
	}
	if in.StartSec < 0 {
		in.StartSec = 0
	}
	if err := b.ensureCacheDir(); err != nil {
		return err
	}
	return b.runCustomStoryBackground(ctx, in, bg, outPath)
}

func (b *Builder) ensureBuilt(
	ctx context.Context,
	in Input,
	kind string,
	outPath string,
	run func(context.Context, Input, string) error,
) (string, error) {
	if b == nil || b.CacheDir == "" {
		return "", errors.New("preview builder not configured")
	}
	if in.TrackID == "" {
		return "", errors.New("track id required")
	}
	if in.AudioPath == "" {
		return "", errors.New("audio path required")
	}
	if in.StartSec < 0 {
		in.StartSec = 0
	}
	if err := b.ensureCacheDir(); err != nil {
		return "", err
	}

	// Fast path: already built. stat is cheap compared to an ffmpeg run.
	if st, err := os.Stat(outPath); err == nil && st.Size() > 0 {
		return outPath, nil
	}

	key := kind + "|" + in.TrackID + "@" + strconv.Itoa(in.StartSec)
	ch := b.group.DoChan(key, func() (any, error) {
		// Re-check inside the singleflight in case another goroutine
		// finished the work between our stat and the singleflight entry.
		if st, err := os.Stat(outPath); err == nil && st.Size() > 0 {
			return outPath, nil
		}
		if err := run(ctx, in, outPath); err != nil {
			// Best-effort cleanup of partial output so the next call retries.
			_ = os.Remove(outPath)
			return "", err
		}
		return outPath, nil
	})
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case res := <-ch:
		if res.Err != nil {
			return "", res.Err
		}
		return res.Val.(string), nil
	}
}

func (b *Builder) ensureCacheDir() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.ensureOK {
		return nil
	}
	if err := os.MkdirAll(b.CacheDir, 0o755); err != nil {
		return fmt.Errorf("create preview cache dir: %w", err)
	}
	b.ensureOK = true
	return nil
}

func (b *Builder) cachePath(trackID string, startSec int) string {
	// File name encodes (trackID, startSec). Both are already URL-safe
	// (UUID + decimal integer).
	name := trackID + "-" + strconv.Itoa(startSec) + ".mp4"
	return filepath.Join(b.CacheDir, name)
}

func (b *Builder) storyCachePath(trackID string, startSec int) string {
	name := trackID + "-" + strconv.Itoa(startSec) + "-story-v12.mp4"
	return filepath.Join(b.CacheDir, name)
}

func (b *Builder) storyBackgroundCachePath(trackID string, startSec int) string {
	name := trackID + "-" + strconv.Itoa(startSec) + "-story-bg-v4.mp4"
	return filepath.Join(b.CacheDir, name)
}

// run invokes ffmpeg. Uses a temp file next to the output so readers never
// see a truncated MP4 if ffmpeg is killed mid-write.
func (b *Builder) run(parent context.Context, in Input, outPath string) error {
	return b.runFFmpeg(parent, buildArgs(in, outPath), outPath)
}

func (b *Builder) runStory(parent context.Context, in Input, outPath string) error {
	framePath := outPath + ".frame.png"
	if err := writeStoryFrame(framePath, in); err != nil {
		return err
	}
	defer os.Remove(framePath)

	return b.runFFmpeg(parent, buildStoryArgs(in, framePath, outPath), outPath)
}

func (b *Builder) runStoryBackground(parent context.Context, in Input, outPath string) error {
	framePath := outPath + ".frame.png"
	if err := writeStoryBackgroundFrame(framePath, in); err != nil {
		return err
	}
	defer os.Remove(framePath)

	return b.runFFmpeg(parent, buildStoryArgs(in, framePath, outPath), outPath)
}

func (b *Builder) runCustomStoryBackground(parent context.Context, in Input, bg CustomBackground, outPath string) error {
	framePath := outPath + ".frame.png"
	if err := writeCustomStoryBackgroundFrame(framePath, bg); err != nil {
		return err
	}
	defer os.Remove(framePath)

	return b.runFFmpeg(parent, buildStoryArgs(in, framePath, outPath), outPath)
}

func (b *Builder) runFFmpeg(parent context.Context, args []string, outPath string) error {
	sem := defaultPreviewFFmpegSemaphore()
	if err := sem.Acquire(parent, 1); err != nil {
		return err
	}
	defer sem.Release(1)

	ctx, cancel := context.WithTimeout(parent, buildTimeout)
	defer cancel()

	tmp := outPath + ".part"
	// In case a previous aborted run left a .part behind.
	_ = os.Remove(tmp)
	args = rewriteOutputPath(args, outPath, tmp)

	bin := b.FFmpegPath
	if bin == "" {
		bin = "ffmpeg"
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	// Suppress ffmpeg's huge stderr output; we only care about exit code.
	// Capture a small tail for error reporting if it fails.
	stderr := &lastBytes{max: 2048}
	cmd.Stderr = stderr
	cmd.Stdout = io.Discard

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ffmpeg failed: %w (stderr tail: %s)", err, stderr.String())
	}

	if st, err := os.Stat(tmp); err != nil {
		return fmt.Errorf("ffmpeg produced no output: %w", err)
	} else if st.Size() == 0 {
		return errors.New("ffmpeg produced empty output")
	}

	if err := os.Rename(tmp, outPath); err != nil {
		return fmt.Errorf("publish preview: %w", err)
	}
	return nil
}

func rewriteOutputPath(args []string, oldOutPath string, tmp string) []string {
	if len(args) == 0 || args[len(args)-1] != oldOutPath {
		return args
	}
	next := append([]string(nil), args[:len(args)-1]...)
	return append(next, tmp)
}

func defaultPreviewFFmpegSemaphore() *semaphore.Weighted {
	defaultFFmpegSemOnce.Do(func() {
		defaultFFmpegSem = semaphore.NewWeighted(defaultFFmpegConcurrency)
	})
	return defaultFFmpegSem
}

// buildArgs constructs the ffmpeg argv. Two input tracks (static image +
// audio slice) muxed to H.264/AAC MP4 at 720x720. 1 fps + -tune stillimage
// keeps the encoded video a few kilobytes; most of the MP4 size is audio.
func buildArgs(in Input, outPath string) []string {
	dur := strconv.Itoa(int(PreviewDuration / time.Second))
	args := []string{
		"-y",
		"-hide_banner",
		"-loglevel", "error",
	}
	hasCover := in.CoverPath != ""
	if hasCover {
		args = append(args,
			"-loop", "1",
			"-framerate", "1",
			"-i", in.CoverPath,
		)
	}
	// Fast seek on the audio input via pre-input -ss. Accurate enough for
	// a 30s preview and much faster than post-input seeking on long files.
	args = append(args,
		"-ss", strconv.Itoa(in.StartSec),
		"-t", dur,
		"-i", in.AudioPath,
	)
	if hasCover {
		// Video from input 0, audio from input 1.
		args = append(args,
			"-map", "0:v:0",
			"-map", "1:a:0",
			"-c:v", "libx264",
			"-pix_fmt", "yuv420p",
			"-tune", "stillimage",
			"-preset", "veryfast",
			"-vf", "scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1",
			"-r", "1",
		)
	} else {
		// Audio-only (no cover available). Produce a tiny black frame so
		// Discord still treats it as an og:video.
		args = append(args,
			"-f", "lavfi",
			"-i", "color=c=black:s=720x720:r=1",
			"-map", "1:v:0",
			"-map", "0:a:0",
			"-c:v", "libx264",
			"-pix_fmt", "yuv420p",
			"-tune", "stillimage",
			"-preset", "veryfast",
			"-r", "1",
		)
	}
	args = append(args,
		"-c:a", "aac",
		"-b:a", "128k",
		"-ac", "2",
		"-shortest",
		"-t", dur,
		"-movflags", "+faststart",
		// Force MP4 muxer explicitly. The output path is a `.part` temp
		// during write, and ffmpeg refuses to auto-detect the format from
		// that extension.
		"-f", "mp4",
		outPath,
	)
	return args
}

func buildStoryArgs(in Input, framePath string, outPath string) []string {
	dur := strconv.Itoa(int(PreviewDuration / time.Second))
	audioIndex := 1
	args := []string{
		"-y",
		"-hide_banner",
		"-loglevel", "error",
		"-loop", "1",
		"-framerate", "30",
		"-i", framePath,
	}
	args = append(args,
		"-ss", strconv.Itoa(in.StartSec),
		"-t", dur,
		"-i", in.AudioPath,
	)

	args = append(args,
		"-map", "0:v:0",
		"-map", strconv.Itoa(audioIndex)+":a:0",
		"-r", "30",
		"-t", dur,
		"-c:v", "libx264",
		"-pix_fmt", "yuv420p",
		"-profile:v", "high",
		"-crf", "10",
		"-tune", "stillimage",
		"-preset", "slow",
		"-c:a", "aac",
		"-b:a", "128k",
		"-ac", "2",
		"-shortest",
		"-movflags", "+faststart",
		"-f", "mp4",
		outPath,
	)
	return args
}

func writeStoryFrame(outPath string, in Input) error {
	img, err := buildStoryFrame(in)
	if err != nil {
		return err
	}
	f, err := os.Create(outPath)
	if err != nil {
		return fmt.Errorf("create story frame: %w", err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		return fmt.Errorf("encode story frame: %w", err)
	}
	return nil
}

func writeStoryBackgroundFrame(outPath string, in Input) error {
	img, err := buildStoryBackgroundFrame(in)
	if err != nil {
		return err
	}
	f, err := os.Create(outPath)
	if err != nil {
		return fmt.Errorf("create story background frame: %w", err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		return fmt.Errorf("encode story background frame: %w", err)
	}
	return nil
}

func writeCustomStoryBackgroundFrame(outPath string, bg CustomBackground) error {
	img, err := buildCustomStoryBackgroundFrame(bg)
	if err != nil {
		return err
	}
	f, err := os.Create(outPath)
	if err != nil {
		return fmt.Errorf("create custom story background frame: %w", err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		return fmt.Errorf("encode custom story background frame: %w", err)
	}
	return nil
}

func buildStoryFrame(in Input) (*image.RGBA, error) {
	img, err := buildStoryBackgroundFrame(in)
	if err != nil {
		return nil, err
	}
	drawStoryCard(img, in)
	return img, nil
}

func buildStoryBackgroundFrame(in Input) (*image.RGBA, error) {
	const (
		w = 1080
		h = 1920
	)
	img := image.NewRGBA(image.Rect(0, 0, w, h))

	if cover, err := decodeImageFile(in.CoverPath); err == nil {
		drawSampledStoryBackground(img, cover, in.TrackID)
	} else {
		drawStoryGradientBackground(img, in)
	}

	return img, nil
}

func buildCustomStoryBackgroundFrame(bg CustomBackground) (*image.RGBA, error) {
	const (
		w = 1080
		h = 1920
	)
	src, err := decodeImageFile(bg.ImagePath)
	if err != nil {
		return nil, err
	}
	srcRect := normalizedCropRect(src.Bounds(), bg.Crop)
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, srcRect, xdraw.Over, nil)
	return dst, nil
}

func normalizedCropRect(bounds image.Rectangle, crop Crop) image.Rectangle {
	w := bounds.Dx()
	h := bounds.Dy()
	if w <= 0 || h <= 0 {
		return bounds
	}

	x := clamp01(crop.X)
	y := clamp01(crop.Y)
	cw := clamp01(crop.Width)
	ch := clamp01(crop.Height)
	if cw <= 0 || ch <= 0 {
		return centerAspectCrop(bounds, 9.0/16.0)
	}
	targetNormAspect := (9.0 / 16.0) * float64(h) / float64(w)
	if current := cw / ch; current > targetNormAspect {
		next := ch * targetNormAspect
		x += (cw - next) / 2
		cw = next
	} else if current < targetNormAspect {
		next := cw / targetNormAspect
		y += (ch - next) / 2
		ch = next
	}
	if x+cw > 1 {
		x = max(0, 1-cw)
	}
	if y+ch > 1 {
		y = max(0, 1-ch)
	}

	minX := bounds.Min.X + int(math.Round(x*float64(w)))
	minY := bounds.Min.Y + int(math.Round(y*float64(h)))
	maxX := bounds.Min.X + int(math.Round((x+cw)*float64(w)))
	maxY := bounds.Min.Y + int(math.Round((y+ch)*float64(h)))
	if maxX <= minX || maxY <= minY {
		return centerAspectCrop(bounds, 9.0/16.0)
	}
	return image.Rect(minX, minY, min(maxX, bounds.Max.X), min(maxY, bounds.Max.Y))
}

func centerAspectCrop(bounds image.Rectangle, aspect float64) image.Rectangle {
	w := bounds.Dx()
	h := bounds.Dy()
	if w <= 0 || h <= 0 || aspect <= 0 {
		return bounds
	}
	srcAspect := float64(w) / float64(h)
	if srcAspect > aspect {
		nextW := max(1, int(math.Round(float64(h)*aspect)))
		x0 := bounds.Min.X + (w-nextW)/2
		return image.Rect(x0, bounds.Min.Y, x0+nextW, bounds.Max.Y)
	}
	nextH := max(1, int(math.Round(float64(w)/aspect)))
	y0 := bounds.Min.Y + (h-nextH)/2
	return image.Rect(bounds.Min.X, y0, bounds.Max.X, y0+nextH)
}

func drawSampledStoryBackground(dst *image.RGBA, cover image.Image, seed string) {
	drawBGGenBackground(dst, cover, 7)
}

func drawStoryGradientBackground(dst *image.RGBA, in Input) {
	bounds := dst.Bounds()
	w := bounds.Dx()
	h := bounds.Dy()
	palette := storyPaletteFromCover(in.CoverPath, in.TrackID)
	rng := seededFloat(in.TrackID)
	noiseSeed := hashSeed(in.TrackID)
	for y := 0; y < h; y++ {
		fy := float64(y) / float64(h)
		for x := 0; x < w; x++ {
			fx := float64(x) / float64(w)
			c := palette.base
			c = mixRGB(c, palette.a, radial(fx, fy, 0.15+rng*0.08, 0.42, 0.55, 0.82), 0.92)
			c = mixRGB(c, palette.b, radial(fx, fy, 0.83, 0.09+rng*0.08, 0.62, 0.42), 0.78)
			c = mixRGB(c, palette.a2, radial(fx, fy, 0.62, 0.52, 0.72, 0.66), 0.62)
			c = mixRGB(c, palette.b2, radial(fx, fy, 0.55, 0.91, 0.66, 0.55), 0.5)
			texture := 0.045*math.Sin(float64(x)*0.015+float64(y)*0.002) +
				0.026*math.Sin(float64(x)*0.004-float64(y)*0.018) +
				0.018*hashNoise(x, y, noiseSeed)
			c = adjustRGB(c, texture)
			dst.SetRGBA(x, y, color.RGBA{R: byte(clamp255(c.r)), G: byte(clamp255(c.g)), B: byte(clamp255(c.b)), A: 255})
		}
	}
}

func drawStoryCard(dst *image.RGBA, in Input) {
	scale := max(1, dst.Bounds().Dx()/1080)
	sc := func(v int) int { return v * scale }

	cardW := sc(720)
	cardH := sc(925)
	cardX := (dst.Bounds().Dx() - cardW) / 2
	cardY := (dst.Bounds().Dy() - cardH) / 2
	cardR := sc(34)
	cardPad := sc(45)
	coverSize := cardW - cardPad*2
	coverX := cardX + cardPad
	coverY := cardY + cardPad
	coverR := sc(9)
	textX := coverX
	textTop := coverY + coverSize + sc(31)
	textW := coverSize
	artistTop := textTop + sc(58)
	brandTop := artistTop + sc(76)

	drawRoundedRect(dst, cardX, cardY, cardW, cardH, cardR, color.RGBA{255, 255, 255, 255})

	if cover, err := decodeImageFile(in.CoverPath); err == nil {
		drawRoundedImage(dst, cover, coverX, coverY, coverSize, coverSize, coverR)
	} else {
		drawRoundedRect(dst, coverX, coverY, coverSize, coverSize, coverR, color.RGBA{232, 233, 238, 255})
	}

	titleFace, titleErr := storyFontFace([]string{
		"SF-Pro-Display-Bold.otf",
		"SF-Pro-Text-Bold.otf",
		"DejaVuSans-Bold.ttf",
	}, float64(sc(50)))
	artistFace, artistErr := storyFontFace([]string{
		"SF-Pro-Text-Regular.otf",
		"SF-Pro-Display-Regular.otf",
		"DejaVuSans.ttf",
	}, float64(sc(44)))
	brandFace, brandErr := storyFontFace([]string{
		"SF-Pro-Text-Semibold.otf",
		"SF-Pro-Display-Semibold.otf",
		"DejaVuSans-Bold.ttf",
	}, float64(sc(36)))
	if titleErr != nil || artistErr != nil || brandErr != nil {
		return
	}

	title := defaultString(in.Title, "Untitled track")
	artist := defaultString(in.Artist, "Unknown artist")
	drawTextTop(dst, titleFace, ellipsizeText(titleFace, title, textW), textX, textTop, color.RGBA{5, 5, 5, 255})
	drawTextTop(dst, artistFace, ellipsizeText(artistFace, artist, textW), textX, artistTop, color.RGBA{16, 16, 20, 255})
	drawLumenBrand(dst, brandFace, textX, brandTop)
}

func drawRoundedImage(dst *image.RGBA, src image.Image, x, y, w, h, r int) {
	square := centerSquare(src.Bounds())
	scaled := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.CatmullRom.Scale(scaled, scaled.Bounds(), src, square, xdraw.Over, nil)
	for py := 0; py < h; py++ {
		for px := 0; px < w; px++ {
			if !insideRoundedRect(px, py, w, h, r) {
				continue
			}
			dst.SetRGBA(x+px, y+py, scaled.RGBAAt(px, py))
		}
	}
}

func centerSquare(r image.Rectangle) image.Rectangle {
	w := r.Dx()
	h := r.Dy()
	if w == h {
		return r
	}
	if w > h {
		d := (w - h) / 2
		return image.Rect(r.Min.X+d, r.Min.Y, r.Max.X-d, r.Max.Y)
	}
	d := (h - w) / 2
	return image.Rect(r.Min.X, r.Min.Y+d, r.Max.X, r.Max.Y-d)
}

func drawRoundedRect(dst *image.RGBA, x, y, w, h, r int, c color.RGBA) {
	bounds := dst.Bounds()
	minX := max(x, bounds.Min.X)
	minY := max(y, bounds.Min.Y)
	maxX := min(x+w, bounds.Max.X)
	maxY := min(y+h, bounds.Max.Y)
	for py := minY; py < maxY; py++ {
		for px := minX; px < maxX; px++ {
			if insideRoundedRect(px-x, py-y, w, h, r) {
				blendRGBA(dst, px, py, c)
			}
		}
	}
}

func insideRoundedRect(px, py, w, h, r int) bool {
	if px < 0 || py < 0 || px >= w || py >= h {
		return false
	}
	if r <= 0 {
		return true
	}
	cx := px
	if px >= w-r {
		cx = w - px - 1
	}
	cy := py
	if py >= h-r {
		cy = h - py - 1
	}
	if cx >= r || cy >= r {
		return true
	}
	dx := float64(r - cx - 1)
	dy := float64(r - cy - 1)
	return dx*dx+dy*dy <= float64(r*r)
}

func blendRGBA(dst *image.RGBA, x, y int, src color.RGBA) {
	if src.A == 255 {
		dst.SetRGBA(x, y, src)
		return
	}
	if src.A == 0 {
		return
	}
	d := dst.RGBAAt(x, y)
	a := float64(src.A) / 255
	dst.SetRGBA(x, y, color.RGBA{
		R: uint8(float64(src.R)*a + float64(d.R)*(1-a)),
		G: uint8(float64(src.G)*a + float64(d.G)*(1-a)),
		B: uint8(float64(src.B)*a + float64(d.B)*(1-a)),
		A: 255,
	})
}

func storyFontFace(names []string, size float64) (font.Face, error) {
	path, err := storyFontFile(names)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	tt, err := opentype.Parse(data)
	if err != nil {
		return nil, err
	}
	return opentype.NewFace(tt, &opentype.FaceOptions{
		Size:    size,
		DPI:     72,
		Hinting: font.HintingFull,
	})
}

func drawTextTop(dst *image.RGBA, face font.Face, text string, x, y int, c color.RGBA) {
	d := &font.Drawer{
		Dst:  dst,
		Src:  image.NewUniform(c),
		Face: face,
		Dot:  fixed.P(x, y+face.Metrics().Ascent.Ceil()),
	}
	d.DrawString(text)
}

func ellipsizeText(face font.Face, text string, maxWidth int) string {
	text = strings.TrimSpace(text)
	if textWidth(face, text) <= maxWidth {
		return text
	}
	r := []rune(text)
	for len(r) > 1 {
		next := string(r[:len(r)-1]) + "..."
		if textWidth(face, next) <= maxWidth {
			return next
		}
		r = r[:len(r)-1]
	}
	return "..."
}

func textWidth(face font.Face, text string) int {
	d := &font.Drawer{Face: face}
	return d.MeasureString(text).Ceil()
}

func drawLumenBrand(dst *image.RGBA, face font.Face, x, y int) {
	scale := max(1, dst.Bounds().Dx()/1080)
	sc := func(v int) int { return v * scale }
	gray := color.RGBA{188, 190, 196, 255}
	drawLumenWaveform(dst, x, y+sc(11), scale, gray)
	drawTextTop(dst, face, "Lumen", x+sc(54), y, gray)
}

func drawLumenWaveform(dst *image.RGBA, x, y int, scale int, c color.RGBA) {
	sc := func(v int) int { return v * scale }
	points := []image.Point{
		{X: x + sc(1), Y: y + sc(18)},
		{X: x + sc(6), Y: y + sc(18)},
		{X: x + sc(10), Y: y + sc(8)},
		{X: x + sc(16), Y: y + sc(30)},
		{X: x + sc(23), Y: y + sc(3)},
		{X: x + sc(31), Y: y + sc(34)},
		{X: x + sc(38), Y: y + sc(14)},
		{X: x + sc(43), Y: y + sc(18)},
	}
	for i := 1; i < len(points); i++ {
		drawThickLine(dst, points[i-1], points[i], sc(5), c)
	}
}

func drawThickLine(dst *image.RGBA, a, b image.Point, radius int, c color.RGBA) {
	dx := b.X - a.X
	dy := b.Y - a.Y
	steps := max(absInt(dx), absInt(dy))
	if steps == 0 {
		drawDisc(dst, a.X, a.Y, radius, c)
		return
	}
	for i := 0; i <= steps; i++ {
		t := float64(i) / float64(steps)
		x := int(math.Round(float64(a.X) + float64(dx)*t))
		y := int(math.Round(float64(a.Y) + float64(dy)*t))
		drawDisc(dst, x, y, radius, c)
	}
}

func drawDisc(dst *image.RGBA, cx, cy, radius int, c color.RGBA) {
	bounds := dst.Bounds()
	r2 := radius * radius
	for y := cy - radius; y <= cy+radius; y++ {
		if y < bounds.Min.Y || y >= bounds.Max.Y {
			continue
		}
		for x := cx - radius; x <= cx+radius; x++ {
			if x < bounds.Min.X || x >= bounds.Max.X {
				continue
			}
			dx := x - cx
			dy := y - cy
			if dx*dx+dy*dy <= r2 {
				blendRGBA(dst, x, y, c)
			}
		}
	}
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

type rgbf struct{ r, g, b float64 }

type storyPalette struct {
	base rgbf
	a    rgbf
	a2   rgbf
	b    rgbf
	b2   rgbf
}

func storyPaletteFromCover(coverPath string, seed string) storyPalette {
	a := rgbf{44, 70, 170}
	b := rgbf{170, 30, 145}
	if coverPath != "" {
		if img, err := decodeImageFile(coverPath); err == nil {
			if p, ok := extractStoryParents(img); ok {
				a = oklchToRGBF(storyOKLCH{l: 0.46, c: math.Max(0.08, math.Min(0.22, p[0].c)), h: p[0].h})
				b = oklchToRGBF(storyOKLCH{l: 0.48, c: math.Max(0.08, math.Min(0.22, p[1].c)), h: p[1].h})
			}
		}
	}
	return storyPalette{
		base: rgbf{28, 28, 45},
		a:    a,
		a2:   mixRGB(a, rgbf{35, 120, 220}, 0.35, 1),
		b:    b,
		b2:   mixRGB(b, rgbf{220, 50, 170}, 0.35, 1),
	}
}

func decodeImageFile(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	return img, err
}

type storyOKLCH struct{ l, c, h float64 }

func extractStoryParents(src image.Image) ([2]storyOKLCH, bool) {
	const size = 36
	dst := image.NewRGBA(image.Rect(0, 0, size, size))
	xdraw.ApproxBiLinear.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Src, nil)
	var colors []storyOKLCH
	for y := 0; y < size; y++ {
		row := y * dst.Stride
		for x := 0; x < size; x++ {
			i := row + x*4
			if dst.Pix[i+3] < 200 {
				continue
			}
			c := rgbToStoryOKLCH(float64(dst.Pix[i]), float64(dst.Pix[i+1]), float64(dst.Pix[i+2]))
			if c.l < 0.16 || c.l > 0.92 || c.c < 0.035 {
				continue
			}
			colors = append(colors, c)
		}
	}
	if len(colors) == 0 {
		return [2]storyOKLCH{}, false
	}
	first := colors[0]
	for _, c := range colors[1:] {
		if c.c*(1-math.Abs(c.l-0.55)) > first.c*(1-math.Abs(first.l-0.55)) {
			first = c
		}
	}
	second := first
	best := -1.0
	for _, c := range colors {
		d := storyColorDistance(first, c)
		if d > best {
			best = d
			second = c
		}
	}
	if best < 0.3 {
		second = storyOKLCH{l: first.l, c: first.c, h: math.Mod(first.h+132, 360)}
	}
	return [2]storyOKLCH{first, second}, true
}

func seededFloat(seed string) float64 {
	return float64(hashSeed(seed)%10000) / 10000
}

func hashSeed(seed string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(seed))
	return h.Sum32()
}

func radial(x, y, cx, cy, rx, ry float64) float64 {
	if rx <= 0 || ry <= 0 {
		return 0
	}
	dx := (x - cx) / rx
	dy := (y - cy) / ry
	d := math.Sqrt(dx*dx + dy*dy)
	if d >= 1 {
		return 0
	}
	t := 1 - d
	return t * t * (3 - 2*t)
}

func mixRGB(a, b rgbf, amount, opacity float64) rgbf {
	t := clamp01(amount * opacity)
	return rgbf{
		r: a.r + (b.r-a.r)*t,
		g: a.g + (b.g-a.g)*t,
		b: a.b + (b.b-a.b)*t,
	}
}

func adjustRGB(c rgbf, amount float64) rgbf {
	d := amount * 255
	return rgbf{r: c.r + d, g: c.g + d*0.86, b: c.b + d*1.08}
}

func hashNoise(x, y int, seed uint32) float64 {
	n := uint32(x)*374761393 + uint32(y)*668265263 + seed*2246822519
	n = (n ^ (n >> 13)) * 1274126177
	n ^= n >> 16
	return float64(n%2001)/1000 - 1
}

func defaultString(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}

func storyFontFile(names []string) (string, error) {
	var dirs []string
	if dir := strings.TrimSpace(os.Getenv("STORY_FONT_DIR")); dir != "" {
		dirs = append(dirs, dir)
	}
	dirs = append(dirs,
		"/app/fonts",                       // optional deploy mount for SF Pro
		"/usr/share/fonts/sf-pro",          // optional system install
		"/usr/share/fonts/dejavu",          // Alpine font-dejavu
		"/usr/share/fonts/truetype/dejavu", // Debian/Ubuntu fonts-dejavu
		"/usr/share/fonts/TTF",             // common fallback in small images
	)
	for _, dir := range dirs {
		for _, name := range names {
			path := filepath.Join(dir, name)
			if st, err := os.Stat(path); err == nil && !st.IsDir() {
				return path, nil
			}
		}
	}
	return "", fmt.Errorf("none of the story fonts were found: %s", strings.Join(names, ", "))
}

// lastBytes is an io.Writer that retains only the tail of what was written,
// so we can surface the bottom of ffmpeg's error output without buffering
// an unbounded pile of progress lines.
type lastBytes struct {
	max int
	buf []byte
}

func (l *lastBytes) Write(p []byte) (int, error) {
	l.buf = append(l.buf, p...)
	if len(l.buf) > l.max {
		l.buf = l.buf[len(l.buf)-l.max:]
	}
	return len(p), nil
}

func (l *lastBytes) String() string { return string(l.buf) }
