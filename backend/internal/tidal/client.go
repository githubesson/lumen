package tidal

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
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
	if _, err := httpx.ValidateDownloadURL(streamURL, mediaDownloadPolicy); err != nil {
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

// FileResponse resolves a TIDAL track to a single, contiguous audio file
// response suitable for download. It mirrors the playback resolution path
// (manifest-first, playback-info fallback, same 10-minute stream-URL cache)
// but instead of returning a rewritten HLS playlist, it descends into the
// playlist (picking the highest-bandwidth variant when the manifest is a
// master playlist), fetches every segment, decrypts AES-128-CBC segments per
// #EXT-X-KEY, and concatenates the decrypted bytes into one streamed body.
//
// Range requests are not supported on the assembled file; the response
// advertises Accept-Ranges: none and is delivered with chunked transfer.
// The incoming request's Range/If-Range headers are intentionally not
// forwarded to segment or playlist fetches.
func (c *Client) FileResponse(ctx context.Context, id string, incoming *http.Request) (*http.Response, error) {
	slog.Debug("tidal hifi file resolve start", "track", id)
	streamURL, err := c.StreamURL(ctx, id)
	if err != nil {
		slog.Warn("tidal hifi file resolve failed", "track", id, "err", err)
		return nil, err
	}
	slog.Debug("tidal hifi file resolved", "track", id, "url", logSafeURL(streamURL))
	return c.assembleHLSFile(ctx, streamURL)
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

func logSafeURL(rawURL string) string {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u.Host == "" {
		return "[invalid-url]"
	}
	u.RawQuery = ""
	u.Fragment = ""
	return u.String()
}

func validateTIDALMediaURL(rawURL string) error {
	u, err := httpx.ValidateDownloadURL(rawURL, mediaDownloadPolicy)
	if err != nil {
		return err
	}
	if mediaHostAllowed(u.Hostname()) {
		return nil
	}
	return fmt.Errorf("tidal media URL host is not allowed")
}

var mediaDownloadPolicy = httpx.DownloadPolicy{}

// mediaHostAllowed reports whether a resolved host is permitted to serve
// TIDAL media. Production restricts to tidal.com / *.tidal.com; tests
// override it to permit loopback origins.
var mediaHostAllowed = defaultTIDALHostAllowed

func defaultTIDALHostAllowed(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	return host == "tidal.com" || strings.HasSuffix(host, ".tidal.com")
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
