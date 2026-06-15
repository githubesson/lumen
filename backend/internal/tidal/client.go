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
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/githubesson/lumen/internal/httpx"
)

var (
	ErrNotConfigured   = errors.New("tidal proxy is not configured")
	ErrDASHManifest    = errors.New("tidal returned a DASH manifest, which this proxy does not yet transcode")
	ErrPreviewManifest = errors.New("tidal returned a preview manifest instead of full playback")
)

type Config struct {
	CountryCode string
	Quality     string
	HifiAPIURL  string
}

type Status struct {
	Connected   bool
	ProxyURL    string
	CountryCode string
	Quality     string
	Version     string
	Repo        string
	Error       string
}

type Client struct {
	cfg    Config
	api    *http.Client
	stream *http.Client

	mu          sync.Mutex
	streamCache map[string]cachedStream
}

type cachedStream struct {
	URL       string
	ExpiresAt time.Time
}

func NewClient(cfg Config) *Client {
	cfg.CountryCode = defaultCountry(cfg.CountryCode)
	cfg.Quality = defaultQuality(cfg.Quality)
	cfg.HifiAPIURL = strings.TrimRight(strings.TrimSpace(cfg.HifiAPIURL), "/")
	return &Client{
		cfg:         cfg,
		api:         &http.Client{Timeout: 30 * time.Second},
		stream:      httpx.DefaultDownloadClient(),
		streamCache: map[string]cachedStream{},
	}
}

func (c *Client) Status(ctx context.Context) (Status, error) {
	status := Status{
		Connected:   false,
		ProxyURL:    c.cfg.HifiAPIURL,
		CountryCode: c.cfg.CountryCode,
		Quality:     c.cfg.Quality,
	}
	if strings.TrimSpace(c.cfg.HifiAPIURL) == "" {
		status.Error = ErrNotConfigured.Error()
		return status, nil
	}
	var out struct {
		Version string `json:"version"`
		Repo    string `json:"Repo"`
	}
	if err := c.doHifiJSON(ctx, c.hifiURL("/").String(), &out); err != nil {
		status.Error = err.Error()
		return status, nil
	}
	status.Connected = true
	status.Version = out.Version
	status.Repo = out.Repo
	return status, nil
}

type Track struct {
	ID          string
	Title       string
	DurationMS  int
	TrackNo     int
	DiscNo      int
	Year        int
	ISRC        string
	Artists     []string
	AlbumID     string
	AlbumTitle  string
	AlbumArtist string
	CoverID     string
	CoverURL    string
}

type Album struct {
	ID          string
	Title       string
	Artist      string
	ReleaseYear int
	TrackCount  int
	DurationMS  int
	CoverID     string
	CoverURL    string
	Tracks      []Track
}

func (t Track) Metadata() map[string]any {
	return map[string]any{
		"album_id":     t.AlbumID,
		"album_artist": t.AlbumArtist,
		"cover_id":     t.CoverID,
		"cover_url":    t.CoverURL,
	}
}

func (c *Client) SearchTracks(ctx context.Context, query string, limit, offset int) ([]Track, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil
	}
	if strings.TrimSpace(c.cfg.HifiAPIURL) == "" {
		return nil, ErrNotConfigured
	}
	if limit <= 0 || limit > 50 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}
	u := c.hifiURL("/search/")
	q := u.Query()
	q.Set("s", query)
	q.Set("limit", strconv.Itoa(limit))
	q.Set("offset", strconv.Itoa(offset))
	u.RawQuery = q.Encode()
	var out struct {
		Version string `json:"version"`
		Data    struct {
			Items []apiTrack `json:"items"`
		} `json:"data"`
	}
	slog.Debug("tidal hifi search request", "query", query, "limit", limit, "offset", offset, "url", logSafeURL(u.String()))
	if err := c.doHifiJSON(ctx, u.String(), &out); err != nil {
		return nil, err
	}
	tracks := make([]Track, 0, len(out.Data.Items))
	for _, item := range out.Data.Items {
		track := item.track()
		if track.ID != "" && track.Title != "" {
			tracks = append(tracks, track)
		}
	}
	slog.Debug("tidal hifi search response", "query", query, "count", len(tracks), "version", out.Version)
	return tracks, nil
}

func (c *Client) Album(ctx context.Context, id string, limit, offset int) (Album, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return Album{}, errors.New("tidal album id is required")
	}
	if strings.TrimSpace(c.cfg.HifiAPIURL) == "" {
		return Album{}, ErrNotConfigured
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}
	u := c.hifiURL("/album/")
	q := u.Query()
	q.Set("id", id)
	q.Set("limit", strconv.Itoa(limit))
	q.Set("offset", strconv.Itoa(offset))
	u.RawQuery = q.Encode()
	var out struct {
		Version string   `json:"version"`
		Data    apiAlbum `json:"data"`
	}
	slog.Debug("tidal hifi album request", "album", id, "limit", limit, "offset", offset, "url", logSafeURL(u.String()))
	if err := c.doHifiJSON(ctx, u.String(), &out); err != nil {
		return Album{}, err
	}
	album := out.Data.album()
	if album.ID == "" {
		return Album{}, errors.New("hifi-api album response did not include an album")
	}
	slog.Debug("tidal hifi album response", "album", id, "title", album.Title, "tracks", len(album.Tracks), "version", out.Version)
	return album, nil
}

func (c *Client) Track(ctx context.Context, id string) (Track, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return Track{}, errors.New("tidal track id is required")
	}
	if strings.TrimSpace(c.cfg.HifiAPIURL) == "" {
		return Track{}, ErrNotConfigured
	}
	u := c.hifiURL("/info/")
	q := u.Query()
	q.Set("id", id)
	u.RawQuery = q.Encode()
	var out struct {
		Version string   `json:"version"`
		Data    apiTrack `json:"data"`
	}
	slog.Debug("tidal hifi track request", "track", id, "url", logSafeURL(u.String()))
	if err := c.doHifiJSON(ctx, u.String(), &out); err != nil {
		return Track{}, err
	}
	track := out.Data.track()
	if track.ID == "" {
		return Track{}, errors.New("hifi-api track response did not include a track")
	}
	slog.Debug("tidal hifi track response", "track", id, "title", track.Title, "version", out.Version)
	return track, nil
}

func (c *Client) StreamResponse(ctx context.Context, id string, incoming *http.Request) (*http.Response, error) {
	streamURL, err := c.StreamURL(ctx, id)
	if err != nil {
		return nil, err
	}
	resp, err := c.openStream(ctx, streamURL, incoming)
	if err == nil && resp.StatusCode != http.StatusForbidden && resp.StatusCode != http.StatusNotFound {
		return resp, nil
	}
	if resp != nil {
		resp.Body.Close()
	}
	c.forgetStream(id)
	streamURL, err = c.StreamURL(ctx, id)
	if err != nil {
		return nil, err
	}
	return c.openStream(ctx, streamURL, incoming)
}

func (c *Client) HLSResponse(ctx context.Context, id string, incoming *http.Request, proxyURL func(string) string) (*http.Response, error) {
	slog.Debug("tidal hifi stream resolve start", "track", id)
	streamURL, err := c.StreamURL(ctx, id)
	if err != nil {
		slog.Warn("tidal hifi stream resolve failed", "track", id, "err", err)
		return nil, err
	}
	slog.Debug("tidal hifi stream resolved", "track", id, "url", logSafeURL(streamURL))
	return c.HLSProxyResponse(ctx, streamURL, incoming, proxyURL)
}

func (c *Client) HLSProxyResponse(ctx context.Context, rawURL string, incoming *http.Request, proxyURL func(string) string) (*http.Response, error) {
	start := time.Now()
	if err := validateTIDALMediaURL(rawURL); err != nil {
		slog.Warn("tidal hls proxy url rejected", "url", logSafeURL(rawURL), "err", err)
		return nil, err
	}
	resp, err := c.openStream(ctx, rawURL, incoming)
	if err != nil {
		slog.Warn("tidal hls proxy fetch failed",
			"url", logSafeURL(rawURL),
			"duration_ms", time.Since(start).Milliseconds(),
			"err", err)
		return nil, err
	}
	contentType := resp.Header.Get("Content-Type")
	isPlaylist := isHLSResponse(resp, rawURL)
	slog.Debug("tidal hls proxy fetch",
		"url", logSafeURL(rawURL),
		"status", resp.StatusCode,
		"content_type", contentType,
		"playlist", isPlaylist,
		"duration_ms", time.Since(start).Milliseconds())
	if !isHLSResponse(resp, rawURL) || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp, nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	resp.Body.Close()
	if err != nil {
		slog.Warn("tidal hls playlist read failed", "url", logSafeURL(rawURL), "err", err)
		return nil, err
	}
	rewritten := rewriteHLSPlaylist(string(body), rawURL, proxyURL)
	slog.Debug("tidal hls playlist rewritten",
		"url", logSafeURL(rawURL),
		"bytes_in", len(body),
		"bytes_out", len(rewritten),
		"duration_ms", time.Since(start).Milliseconds())
	header := resp.Header.Clone()
	header.Del("Content-Length")
	header.Del("Content-Range")
	header.Set("Content-Type", "application/vnd.apple.mpegurl")
	header.Set("Cache-Control", "private, max-age=0")
	return &http.Response{
		StatusCode:    resp.StatusCode,
		Status:        resp.Status,
		Header:        header,
		Body:          io.NopCloser(strings.NewReader(rewritten)),
		ContentLength: int64(len(rewritten)),
	}, nil
}

func (c *Client) openStream(ctx context.Context, streamURL string, incoming *http.Request) (*http.Response, error) {
	if _, err := httpx.ValidateDownloadURL(streamURL, httpx.DownloadPolicy{}); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, streamURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", httpx.BrowserUserAgent)
	req.Header.Set("Accept", "*/*")
	if incoming != nil {
		for _, name := range []string{"Range", "If-Range"} {
			if v := incoming.Header.Get(name); v != "" {
				req.Header.Set(name, v)
			}
		}
	}
	return c.stream.Do(req)
}

func (c *Client) StreamURL(ctx context.Context, id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New("tidal track id is required")
	}
	if strings.TrimSpace(c.cfg.HifiAPIURL) == "" {
		return "", ErrNotConfigured
	}
	key := c.cacheKey(id)
	c.mu.Lock()
	if cached, ok := c.streamCache[key]; ok && time.Now().Before(cached.ExpiresAt) {
		c.mu.Unlock()
		slog.Debug("tidal hifi stream cache hit",
			"track", id,
			"quality", defaultQuality(c.cfg.Quality),
			"url", logSafeURL(cached.URL),
			"expires_in_sec", int(time.Until(cached.ExpiresAt).Seconds()))
		return cached.URL, nil
	}
	c.mu.Unlock()
	slog.Debug("tidal hifi stream cache miss", "track", id, "quality", defaultQuality(c.cfg.Quality))
	streamURL, err := c.resolveHifiStream(ctx, id)
	if err != nil {
		slog.Warn("tidal hifi stream manifest resolve failed", "track", id, "quality", defaultQuality(c.cfg.Quality), "err", err)
		return "", fmt.Errorf("hifi-api playback failed: %w", err)
	}
	c.mu.Lock()
	c.streamCache[key] = cachedStream{URL: streamURL, ExpiresAt: time.Now().Add(10 * time.Minute)}
	c.mu.Unlock()
	slog.Debug("tidal hifi stream cached", "track", id, "quality", defaultQuality(c.cfg.Quality), "url", logSafeURL(streamURL))
	return streamURL, nil
}

func (c *Client) forgetStream(id string) {
	c.mu.Lock()
	delete(c.streamCache, c.cacheKey(id))
	c.mu.Unlock()
}

func (c *Client) cacheKey(id string) string {
	return "hifi:" + strings.TrimSpace(id) + ":" + defaultQuality(c.cfg.Quality)
}

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

func logSafeURL(rawURL string) string {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u.Host == "" {
		return "[invalid-url]"
	}
	u.RawQuery = ""
	u.Fragment = ""
	return u.String()
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

func validateTIDALMediaURL(rawURL string) error {
	u, err := httpx.ValidateDownloadURL(rawURL, httpx.DownloadPolicy{})
	if err != nil {
		return err
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if host == "tidal.com" || strings.HasSuffix(host, ".tidal.com") {
		return nil
	}
	return fmt.Errorf("tidal media URL host is not allowed")
}

func isHLSResponse(resp *http.Response, rawURL string) bool {
	if resp == nil {
		return false
	}
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.Contains(ct, "mpegurl") || strings.Contains(ct, "application/vnd.apple") {
		return true
	}
	u, err := url.Parse(rawURL)
	return err == nil && strings.HasSuffix(strings.ToLower(u.Path), ".m3u8")
}

func rewriteHLSPlaylist(playlist, baseRawURL string, proxyURL func(string) string) string {
	if proxyURL == nil {
		return playlist
	}
	base, _ := url.Parse(baseRawURL)
	lines := strings.Split(playlist, "\n")
	for i, line := range lines {
		lines[i] = rewriteHLSURIAttributes(line, base, proxyURL)
		trimmed := strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		resolved := resolveHLSURI(base, trimmed)
		if resolved != "" {
			lines[i] = proxyURL(resolved)
		}
	}
	return strings.Join(lines, "\n")
}

func rewriteHLSURIAttributes(line string, base *url.URL, proxyURL func(string) string) string {
	return hlsURIAttrRe.ReplaceAllStringFunc(line, func(match string) string {
		parts := hlsURIAttrRe.FindStringSubmatch(match)
		if len(parts) != 2 {
			return match
		}
		resolved := resolveHLSURI(base, parts[1])
		if resolved == "" {
			return match
		}
		return `URI="` + proxyURL(resolved) + `"`
	})
}

func resolveHLSURI(base *url.URL, rawURI string) string {
	u, err := url.Parse(strings.TrimSpace(rawURI))
	if err != nil {
		return ""
	}
	if base != nil {
		u = base.ResolveReference(u)
	}
	return u.String()
}

var (
	urlRe        = regexp.MustCompile(`https?://[^\s"'<>()]+`)
	hlsURIAttrRe = regexp.MustCompile(`URI="([^"]+)"`)
)

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

type tidalID string

func (id *tidalID) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		*id = tidalID(s)
		return nil
	}
	var n json.Number
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	if err := dec.Decode(&n); err != nil {
		return err
	}
	*id = tidalID(n.String())
	return nil
}

type apiArtist struct {
	Name string `json:"name"`
}

type apiAlbum struct {
	ID             tidalID        `json:"id"`
	Title          string         `json:"title"`
	Cover          string         `json:"cover"`
	ReleaseDate    string         `json:"releaseDate"`
	Duration       int            `json:"duration"`
	NumberOfTracks int            `json:"numberOfTracks"`
	Artist         apiArtist      `json:"artist"`
	Artists        []apiArtist    `json:"artists"`
	Items          []apiAlbumItem `json:"items"`
}

type apiTrack struct {
	ID           tidalID     `json:"id"`
	Title        string      `json:"title"`
	Duration     int         `json:"duration"`
	TrackNumber  int         `json:"trackNumber"`
	VolumeNumber int         `json:"volumeNumber"`
	ISRC         string      `json:"isrc"`
	Artist       apiArtist   `json:"artist"`
	Artists      []apiArtist `json:"artists"`
	Album        apiAlbum    `json:"album"`
}

type apiAlbumItem struct {
	Item apiTrack `json:"item"`
	Type string   `json:"type"`
}

func (a apiAlbum) album() Album {
	year := 0
	if len(a.ReleaseDate) >= 4 {
		year, _ = strconv.Atoi(a.ReleaseDate[:4])
	}
	artist := strings.TrimSpace(a.Artist.Name)
	if artist == "" && len(a.Artists) > 0 {
		artist = strings.TrimSpace(a.Artists[0].Name)
	}
	coverID := strings.TrimSpace(a.Cover)
	album := Album{
		ID:          string(a.ID),
		Title:       a.Title,
		Artist:      artist,
		ReleaseYear: year,
		TrackCount:  a.NumberOfTracks,
		DurationMS:  max(0, a.Duration) * 1000,
		CoverID:     coverID,
		CoverURL:    CoverURL(coverID, 640),
		Tracks:      make([]Track, 0, len(a.Items)),
	}
	for _, item := range a.Items {
		if item.Type != "" && !strings.EqualFold(item.Type, "track") {
			continue
		}
		track := item.Item.track()
		if track.ID == "" || track.Title == "" {
			continue
		}
		if track.AlbumID == "" {
			track.AlbumID = album.ID
		}
		if track.AlbumTitle == "" {
			track.AlbumTitle = album.Title
		}
		if track.AlbumArtist == "" {
			track.AlbumArtist = album.Artist
		}
		if track.CoverID == "" {
			track.CoverID = album.CoverID
			track.CoverURL = album.CoverURL
		}
		album.Tracks = append(album.Tracks, track)
	}
	if album.TrackCount == 0 {
		album.TrackCount = len(album.Tracks)
	}
	return album
}

func (t apiTrack) track() Track {
	artists := make([]string, 0, len(t.Artists))
	seen := map[string]struct{}{}
	for _, a := range t.Artists {
		name := strings.TrimSpace(a.Name)
		if name == "" {
			continue
		}
		if _, ok := seen[strings.ToLower(name)]; ok {
			continue
		}
		seen[strings.ToLower(name)] = struct{}{}
		artists = append(artists, name)
	}
	if len(artists) == 0 && strings.TrimSpace(t.Artist.Name) != "" {
		artists = append(artists, strings.TrimSpace(t.Artist.Name))
	}
	year := 0
	if len(t.Album.ReleaseDate) >= 4 {
		year, _ = strconv.Atoi(t.Album.ReleaseDate[:4])
	}
	coverID := strings.TrimSpace(t.Album.Cover)
	return Track{
		ID:          string(t.ID),
		Title:       t.Title,
		DurationMS:  max(0, t.Duration) * 1000,
		TrackNo:     t.TrackNumber,
		DiscNo:      t.VolumeNumber,
		Year:        year,
		ISRC:        t.ISRC,
		Artists:     artists,
		AlbumID:     string(t.Album.ID),
		AlbumTitle:  t.Album.Title,
		AlbumArtist: t.Album.Artist.Name,
		CoverID:     coverID,
		CoverURL:    CoverURL(coverID, 640),
	}
}

func CoverURL(id string, size int) string {
	id = strings.TrimSpace(id)
	if id == "" {
		return ""
	}
	if strings.HasPrefix(id, "http://") || strings.HasPrefix(id, "https://") {
		return id
	}
	if size <= 0 {
		size = 640
	}
	formatted := strings.ReplaceAll(id, "-", "/")
	return fmt.Sprintf("https://resources.tidal.com/images/%s/%dx%d.jpg", formatted, size, size)
}

func defaultCountry(country string) string {
	country = strings.ToUpper(strings.TrimSpace(country))
	if country == "" {
		return "US"
	}
	return country
}

func defaultQuality(quality string) string {
	quality = strings.ToUpper(strings.TrimSpace(quality))
	if quality == "" {
		return "LOSSLESS"
	}
	return quality
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
