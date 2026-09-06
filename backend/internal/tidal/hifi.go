package tidal

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/githubesson/lumen/internal/httpx"
)

func (c *Client) resolveHifiStream(ctx context.Context, id string) (string, error) {
	streamURL, err := c.resolveHifiTrackManifest(ctx, id)
	if err == nil {
		return streamURL, nil
	}
	slog.Warn("tidal hifi hls manifest resolve failed; falling back to playbackinfo",
		"track", id,
		"quality", defaultQuality(c.cfg.Quality),
		"err", err)
	fallbackURL, fallbackErr := c.resolveHifiPlaybackInfo(ctx, id)
	if fallbackErr == nil {
		return fallbackURL, nil
	}
	return "", errors.Join(err, fallbackErr)
}

func (c *Client) resolveHifiTrackManifest(ctx context.Context, id string) (string, error) {
	u := c.hifiURL("/trackManifests/")
	q := u.Query()
	q.Set("id", id)
	q.Set("adaptive", "false")
	q.Set("manifestType", "HLS")
	q.Set("uriScheme", "HTTPS")
	q.Set("usage", "PLAYBACK")
	for _, format := range hifiManifestFormats(c.cfg.Quality) {
		q.Add("formats", format)
	}
	u.RawQuery = q.Encode()
	slog.Debug("tidal hifi track manifest request",
		"track", id,
		"quality", defaultQuality(c.cfg.Quality),
		"formats", strings.Join(hifiManifestFormats(c.cfg.Quality), ","),
		"url", logSafeURL(u.String()))
	var out struct {
		Version string `json:"version"`
		Data    struct {
			Data struct {
				Attributes struct {
					TrackPresentation string   `json:"trackPresentation"`
					PreviewReason     string   `json:"previewReason"`
					URI               string   `json:"uri"`
					Manifest          string   `json:"manifest"`
					Formats           []string `json:"formats"`
				} `json:"attributes"`
			} `json:"data"`
		} `json:"data"`
	}
	if err := c.doHifiJSON(ctx, u.String(), &out); err != nil {
		return "", err
	}
	attrs := out.Data.Data.Attributes
	slog.Debug("tidal hifi track manifest response",
		"track", id,
		"version", out.Version,
		"presentation", attrs.TrackPresentation,
		"preview_reason", attrs.PreviewReason,
		"formats", strings.Join(attrs.Formats, ","),
		"manifest_inline", attrs.Manifest != "",
		"uri", logSafeURL(attrs.URI))
	if strings.EqualFold(attrs.TrackPresentation, "PREVIEW") {
		reason := strings.TrimSpace(attrs.PreviewReason)
		if reason == "" {
			reason = "unknown reason"
		}
		return "", fmt.Errorf("%w (%s)", ErrPreviewManifest, reason)
	}
	if attrs.URI != "" {
		if err := validateTIDALMediaURL(attrs.URI); err != nil {
			slog.Warn("tidal hifi track manifest uri rejected", "track", id, "uri", logSafeURL(attrs.URI), "err", err)
			return "", err
		}
		return attrs.URI, nil
	}
	if attrs.Manifest != "" {
		streamURL, err := extractStreamURL(attrs.Manifest)
		if err != nil {
			return "", err
		}
		if err := validateTIDALMediaURL(streamURL); err != nil {
			slog.Warn("tidal hifi inline manifest url rejected", "track", id, "url", logSafeURL(streamURL), "err", err)
			return "", err
		}
		return streamURL, nil
	}
	return "", errors.New("hifi-api track manifest response did not include uri or manifest")
}

func (c *Client) resolveHifiPlaybackInfo(ctx context.Context, id string) (string, error) {
	var lastErr error
	qualities := hifiQualityAttempts(c.cfg.Quality)
	for i, quality := range qualities {
		streamURL, err := c.resolveHifiPlaybackInfoWithQuality(ctx, id, quality, i+1, len(qualities))
		if err == nil {
			return streamURL, nil
		}
		lastErr = err
		if i+1 < len(qualities) {
			slog.Warn("tidal hifi playback attempt failed; retrying lower quality",
				"track", id,
				"requested_quality", defaultQuality(c.cfg.Quality),
				"hifi_quality", quality,
				"attempt", i+1,
				"err", err)
		}
	}
	if lastErr == nil {
		lastErr = errors.New("no hifi-api playback qualities configured")
	}
	return "", lastErr
}

func (c *Client) resolveHifiPlaybackInfoWithQuality(ctx context.Context, id, quality string, attempt, totalAttempts int) (string, error) {
	u := c.hifiURL("/track/")
	q := u.Query()
	q.Set("id", id)
	q.Set("quality", quality)
	q.Set("immersiveaudio", "false")
	u.RawQuery = q.Encode()
	slog.Debug("tidal hifi playback request",
		"track", id,
		"requested_quality", defaultQuality(c.cfg.Quality),
		"hifi_quality", quality,
		"attempt", attempt,
		"attempts", totalAttempts,
		"url", logSafeURL(u.String()))
	var out struct {
		Version string `json:"version"`
		Data    struct {
			AssetPresentation string `json:"assetPresentation"`
			AudioQuality      string `json:"audioQuality"`
			ManifestMimeType  string `json:"manifestMimeType"`
			Manifest          string `json:"manifest"`
		} `json:"data"`
	}
	if err := c.doHifiJSON(ctx, u.String(), &out); err != nil {
		return "", err
	}
	slog.Debug("tidal hifi playback response",
		"track", id,
		"version", out.Version,
		"presentation", out.Data.AssetPresentation,
		"audio_quality", out.Data.AudioQuality,
		"manifest_mime", out.Data.ManifestMimeType,
		"manifest_inline", out.Data.Manifest != "")
	if strings.EqualFold(out.Data.AssetPresentation, "PREVIEW") {
		return "", ErrPreviewManifest
	}
	if !strings.EqualFold(out.Data.AssetPresentation, "FULL") {
		slog.Warn("tidal hifi playback unexpected presentation", "track", id, "presentation", out.Data.AssetPresentation)
	}
	streamURL, err := extractStreamURL(out.Data.Manifest)
	if err != nil {
		return "", err
	}
	if err := validateTIDALMediaURL(streamURL); err != nil {
		slog.Warn("tidal hifi stream url rejected", "track", id, "url", logSafeURL(streamURL), "err", err)
		return "", err
	}
	return streamURL, nil
}

func (c *Client) doHifiJSON(ctx context.Context, rawURL string, dst any) error {
	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", httpx.BrowserUserAgent)
	resp, err := c.api.Do(req)
	if err != nil {
		slog.Warn("tidal hifi request failed",
			"url", logSafeURL(rawURL),
			"duration_ms", time.Since(start).Milliseconds(),
			"err", err)
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		slog.Warn("tidal hifi request non-2xx",
			"url", logSafeURL(rawURL),
			"status", resp.StatusCode,
			"duration_ms", time.Since(start).Milliseconds(),
			"body", strings.TrimSpace(string(body)))
		return fmt.Errorf("hifi-api request failed: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	slog.Debug("tidal hifi request ok",
		"url", logSafeURL(rawURL),
		"status", resp.StatusCode,
		"duration_ms", time.Since(start).Milliseconds())
	return json.NewDecoder(resp.Body).Decode(dst)
}

func (c *Client) hifiURL(p string) *url.URL {
	base, _ := url.Parse(strings.TrimRight(strings.TrimSpace(c.cfg.HifiAPIURL), "/"))
	rel := &url.URL{Path: p}
	return base.ResolveReference(rel)
}

func extractStreamURL(manifest string) (string, error) {
	manifest = strings.TrimSpace(manifest)
	if manifest == "" {
		return "", errors.New("empty tidal manifest")
	}
	if decoded, ok := decodeManifest(manifest); ok {
		manifest = strings.TrimSpace(decoded)
	}
	if strings.Contains(manifest, "<MPD") {
		return "", ErrDASHManifest
	}
	if strings.HasPrefix(manifest, "{") {
		var payload struct {
			URLs []string `json:"urls"`
			URL  string   `json:"url"`
		}
		if err := json.Unmarshal([]byte(manifest), &payload); err == nil {
			if payload.URL != "" {
				return payload.URL, nil
			}
			if len(payload.URLs) > 0 {
				return pickBestURL(payload.URLs)
			}
		}
	}
	if urls := urlRe.FindAllString(manifest, -1); len(urls) > 0 {
		return pickBestURL(urls)
	}
	return "", errors.New("tidal manifest did not include a playable URL")
}

func decodeManifest(s string) (string, bool) {
	if strings.HasPrefix(s, "{") || strings.Contains(s, "<MPD") {
		return s, false
	}
	for _, enc := range []*base64.Encoding{
		base64.StdEncoding,
		base64.RawStdEncoding,
		base64.URLEncoding,
		base64.RawURLEncoding,
	} {
		if b, err := enc.DecodeString(s); err == nil && len(bytes.TrimSpace(b)) > 0 {
			return string(b), true
		}
	}
	return s, false
}

func pickBestURL(urls []string) (string, error) {
	if len(urls) == 0 {
		return "", errors.New("tidal manifest did not include a playable URL")
	}
	best := urls[0]
	bestScore := scoreURL(best)
	for _, u := range urls[1:] {
		if s := scoreURL(u); s > bestScore {
			best, bestScore = u, s
		}
	}
	return best, nil
}

func scoreURL(u string) int {
	lower := strings.ToLower(u)
	score := 0
	for token, weight := range map[string]int{
		"flac": 40, "lossless": 30, "hires": 25, "hi_res": 25,
		"mqa": 20, "aac": 5, "mp4": 4, "m4a": 4,
	} {
		if strings.Contains(lower, token) {
			score += weight
		}
	}
	return score
}

func hifiQualityAttempts(quality string) []string {
	switch defaultQuality(quality) {
	case "HI_RES", "HI_RES_LOSSLESS", "MAX":
		return []string{"HI_RES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"}
	case "HIGH":
		return []string{"HIGH", "LOW"}
	case "LOW":
		return []string{"LOW"}
	default:
		return []string{"LOSSLESS", "HIGH", "LOW"}
	}
}

func hifiManifestFormats(quality string) []string {
	switch defaultQuality(quality) {
	case "HI_RES", "HI_RES_LOSSLESS", "MAX":
		return []string{"FLAC_HIRES", "FLAC", "AACLC", "HEAACV1"}
	case "HIGH":
		return []string{"AACLC", "HEAACV1"}
	case "LOW":
		return []string{"HEAACV1"}
	default:
		return []string{"FLAC", "AACLC", "HEAACV1"}
	}
}
