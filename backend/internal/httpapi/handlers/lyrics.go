package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	fhttp "github.com/bogdanfinn/fhttp"
	tlsclient "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
	"golang.org/x/net/html"
	"golang.org/x/text/unicode/norm"
)

const (
	defaultLRCLibBase = "https://lrclib.net"
	defaultGeniusBase = "https://genius.com"
	maxLyricsBody     = 4 << 20
	lrclibMaxAttempts = 3
	geniusUserAgent   = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
)

var errLyricsNotFound = errors.New("lyrics not found")

var versionTagPattern = regexp.MustCompile(`(?i)[\[(]\s*(?:v(?:er(?:sion)?)?\s*)?\d+\s*[\])]`)
var lrcTimestampPattern = regexp.MustCompile(`\[\d{1,3}:\d{2}(?:\.\d{1,3})?\]`)
var featuredTitleSuffixPattern = regexp.MustCompile(`(?i)\s*[\[(]\s*(?:feat(?:uring)?\.?|ft\.?)\s+.*(?:[\])])?\s*$`)
var trailingTitleQualifierPattern = regexp.MustCompile(`\s*[\[(][^\])]+[\])]\s*$`)

// Lyrics races LRCLIB against Genius and returns the first usable result.
// Genius is searched through its public web API, then its first matching song
// page is scraped and normalized to the LRCLIB-shaped response used by clients.
type Lyrics struct {
	BaseURL        string
	GeniusBaseURL  string
	GeniusProxyURL string
	Client         *http.Client
}

type lyricsResponse struct {
	provider string
	status   int
	header   http.Header
	body     []byte
	err      error
}

type geniusSession struct {
	standard *http.Client
	tls      tlsclient.HttpClient
}

type geniusSearchResponse struct {
	Response struct {
		Sections []struct {
			Hits []struct {
				Type   string `json:"type"`
				Result struct {
					ID          int64  `json:"id"`
					Title       string `json:"title"`
					ArtistNames string `json:"artist_names"`
					URL         string `json:"url"`
				} `json:"result"`
			} `json:"hits"`
		} `json:"sections"`
	} `json:"response"`
}

type geniusLyricsResult struct {
	ID           int64   `json:"id"`
	Name         string  `json:"name"`
	SyncedLyrics *string `json:"syncedLyrics"`
	PlainLyrics  string  `json:"plainLyrics"`
	Instrumental bool    `json:"instrumental"`
	TrackName    string  `json:"trackName"`
	ArtistName   string  `json:"artistName"`
}

type geniusSong struct {
	ID          int64
	Title       string
	ArtistNames string
	URL         string
}

type lrclibCandidate struct {
	TrackName    string  `json:"trackName"`
	ArtistName   string  `json:"artistName"`
	AlbumName    string  `json:"albumName"`
	Duration     float64 `json:"duration"`
	SyncedLyrics *string `json:"syncedLyrics"`
	PlainLyrics  *string `json:"plainLyrics"`
	Instrumental bool    `json:"instrumental"`
}

func (h *Lyrics) lrclibBaseURL() string {
	if h.BaseURL != "" {
		return strings.TrimRight(h.BaseURL, "/")
	}
	return defaultLRCLibBase
}

func (h *Lyrics) geniusBaseURL() string {
	if h.GeniusBaseURL != "" {
		return strings.TrimRight(h.GeniusBaseURL, "/")
	}
	return defaultGeniusBase
}

func (h *Lyrics) httpClient() *http.Client {
	if h.Client != nil {
		return h.Client
	}
	return &http.Client{Timeout: 15 * time.Second}
}

func (h *Lyrics) isSearch(q url.Values) bool {
	return q.Has("q") && !q.Has("track_name") && !q.Has("duration")
}

// Handle starts both providers together, but gives LRCLIB priority because it
// can provide synced lyrics. A completed Genius result is held until LRCLIB
// either returns usable lyrics or definitively fails.
func (h *Lyrics) Handle(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	results := make(chan lyricsResponse, 2)
	go func() { results <- h.fetchLRCLib(ctx, r.URL.Query()) }()
	go func() { results <- h.fetchGenius(ctx, r.URL.Query()) }()

	var failures []error
	var geniusFallback *lyricsResponse
	lrclibDone := false
	for range 2 {
		result := <-results
		if result.err != nil {
			if !errors.Is(result.err, context.Canceled) {
				failures = append(failures, fmt.Errorf("%s: %w", result.provider, result.err))
			}
			if result.provider == "lrclib" {
				lrclibDone = true
				if geniusFallback != nil {
					writeLyricsResponse(w, cancel, *geniusFallback)
					return
				}
			}
			continue
		}

		if result.provider == "lrclib" {
			writeLyricsResponse(w, cancel, result)
			return
		}
		if lrclibDone {
			writeLyricsResponse(w, cancel, result)
			return
		}
		geniusFallback = &result
	}

	if len(failures) > 0 {
		slog.Warn("lyrics proxy: all providers failed", "errors", errors.Join(failures...))
	}
	http.Error(w, "lyrics_not_found", http.StatusNotFound)
}

func writeLyricsResponse(w http.ResponseWriter, cancel context.CancelFunc, result lyricsResponse) {
	cancel()
	copyLyricsHeaders(w.Header(), result.header)
	w.Header().Set("X-Lyrics-Provider", result.provider)
	w.WriteHeader(result.status)
	if _, err := w.Write(result.body); err != nil {
		slog.Warn("lyrics proxy: response write failed", "provider", result.provider, "err", err)
	}
	slog.Debug("lyrics proxy: request completed", "provider", result.provider, "status", result.status, "bytes", len(result.body))
}

func (h *Lyrics) fetchLRCLib(ctx context.Context, query url.Values) lyricsResponse {
	result := lyricsResponse{provider: "lrclib"}

	values := url.Values{}
	// Album is deliberately omitted from the upstream search because deluxe,
	// remastered, and regional releases frequently use different album names.
	// It remains available in query for local candidate tie-breaking below.
	for _, key := range []string{"track_name", "artist_name", "q"} {
		if value := query.Get(key); value != "" {
			if key == "track_name" || key == "artist_name" || key == "q" {
				value = cleanLyricsSearchTerm(value)
			}
			if value == "" {
				continue
			}
			values.Set(key, value)
		}
	}
	target := h.lrclibBaseURL() + "/api/search"
	if len(values) > 0 {
		target += "?" + values.Encode()
	}

	var resp *http.Response
	var body []byte
	var err error
	for attempt := 1; attempt <= lrclibMaxAttempts; attempt++ {
		resp, body, err = h.fetchLRCLibAttempt(ctx, target)
		if err == nil && !retryableLRCLibStatus(resp.StatusCode) {
			break
		}
		if attempt == lrclibMaxAttempts || ctx.Err() != nil {
			break
		}
		if !waitForRetry(ctx, time.Duration(attempt)*100*time.Millisecond) {
			break
		}
	}
	if err != nil {
		result.err = err
		return result
	}
	if len(body) > maxLyricsBody {
		result.err = errors.New("response exceeds size limit")
		return result
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		result.err = errLyricsNotFound
		return result
	}
	if h.isSearch(query) {
		if !validLRCLibBody(body, true) {
			result.err = errLyricsNotFound
			return result
		}
	} else {
		selected, ok := selectLRCLibCandidate(body, query)
		if !ok {
			result.err = errLyricsNotFound
			return result
		}
		body = selected
	}

	result.status = resp.StatusCode
	result.header = resp.Header.Clone()
	result.body = body
	return result
}

func (h *Lyrics) fetchLRCLibAttempt(ctx context.Context, target string) (*http.Response, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("User-Agent", "wuby.run (lyrics-proxy)")
	req.Header.Set("Accept", "application/json")
	resp, err := h.httpClient().Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxLyricsBody+1))
	if err != nil {
		return nil, nil, err
	}
	return resp, body, nil
}

func retryableLRCLibStatus(status int) bool {
	return status == http.StatusTooManyRequests || status >= 500
}

func waitForRetry(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func selectLRCLibCandidate(body []byte, query url.Values) ([]byte, bool) {
	var rawCandidates []json.RawMessage
	if json.Unmarshal(body, &rawCandidates) != nil || len(rawCandidates) == 0 {
		return nil, false
	}

	requestedTitle := comparableLyricsTitle(query.Get("track_name"))
	requestedArtist := comparableLyricsMetadata(query.Get("artist_name"))
	requestedAlbum := comparableLyricsMetadata(query.Get("album_name"))
	requestedDuration, _ := strconv.ParseFloat(query.Get("duration"), 64)
	bestIndex, bestScore := -1, -1
	for index, raw := range rawCandidates {
		var candidate lrclibCandidate
		if json.Unmarshal(raw, &candidate) != nil {
			continue
		}
		if requestedTitle != "" && comparableLyricsTitle(candidate.TrackName) != requestedTitle {
			continue
		}
		if requestedArtist != "" {
			actualArtist := comparableLyricsMetadata(candidate.ArtistName)
			if !strings.Contains(actualArtist, requestedArtist) && !strings.Contains(requestedArtist, actualArtist) {
				continue
			}
		}

		score := 0
		synced := ""
		if candidate.SyncedLyrics != nil {
			synced = strings.TrimSpace(*candidate.SyncedLyrics)
		}
		timestamps := lrcTimestampPattern.FindAllStringIndex(synced, -1)
		switch {
		case len(timestamps) > 0:
			score = 3000 + min(len(timestamps), 100)
		case synced != "":
			score = 2000
		case nonEmpty(candidate.PlainLyrics):
			score = 1000
		case candidate.Instrumental:
			score = 500
		default:
			continue
		}
		if requestedAlbum != "" && comparableLyricsMetadata(candidate.AlbumName) == requestedAlbum {
			score += 200
		}
		if requestedDuration > 0 && candidate.Duration > 0 {
			difference := math.Abs(candidate.Duration - requestedDuration)
			score += max(0, 100-int(math.Round(difference))*10)
		}
		if score > bestScore {
			bestIndex, bestScore = index, score
		}
	}
	if bestIndex < 0 {
		return nil, false
	}
	return rawCandidates[bestIndex], true
}

func validLRCLibBody(body []byte, search bool) bool {
	if search {
		var rows []struct {
			SyncedLyrics *string `json:"syncedLyrics"`
			PlainLyrics  *string `json:"plainLyrics"`
			Instrumental bool    `json:"instrumental"`
		}
		if json.Unmarshal(body, &rows) != nil || len(rows) == 0 {
			return false
		}
		for _, row := range rows {
			if row.Instrumental || nonEmpty(row.SyncedLyrics) || nonEmpty(row.PlainLyrics) {
				return true
			}
		}
		return false
	}

	var row struct {
		SyncedLyrics *string `json:"syncedLyrics"`
		PlainLyrics  *string `json:"plainLyrics"`
		Instrumental bool    `json:"instrumental"`
	}
	return json.Unmarshal(body, &row) == nil && (row.Instrumental || nonEmpty(row.SyncedLyrics) || nonEmpty(row.PlainLyrics))
}

func nonEmpty(value *string) bool {
	return value != nil && strings.TrimSpace(*value) != ""
}

func (h *Lyrics) fetchGenius(ctx context.Context, query url.Values) lyricsResponse {
	result := lyricsResponse{provider: "genius"}
	requestedTitle := cleanLyricsSearchTerm(query.Get("track_name"))
	requestedArtist := cleanLyricsSearchTerm(query.Get("artist_name"))
	searchQuery := cleanLyricsSearchTerm(query.Get("q"))
	if searchQuery == "" {
		searchQuery = strings.TrimSpace(requestedTitle + " " + requestedArtist)
	}
	if searchQuery == "" {
		result.err = errLyricsNotFound
		return result
	}
	session, err := h.newGeniusSession()
	if err != nil {
		result.err = err
		return result
	}
	if session.tls != nil {
		defer session.tls.CloseIdleConnections()
	}

	searchURL := h.geniusBaseURL() + "/api/search/multi?per_page=5&q=" + url.QueryEscape(searchQuery)
	var search geniusSearchResponse
	if err := session.getJSON(ctx, searchURL, &search); err != nil {
		result.err = sanitizeProxyError(err, h.GeniusProxyURL)
		return result
	}

	var song geniusSong
	bestMatchScore := 0
	for _, section := range search.Response.Sections {
		for _, hit := range section.Hits {
			if hit.Type != "song" || hit.Result.URL == "" {
				continue
			}
			candidate := geniusSong{
				ID:          hit.Result.ID,
				Title:       hit.Result.Title,
				ArtistNames: hit.Result.ArtistNames,
				URL:         hit.Result.URL,
			}
			matchScore := 1
			if requestedTitle != "" {
				matchScore = geniusMetadataMatchScore(candidate, requestedTitle, requestedArtist)
			}
			if matchScore <= bestMatchScore {
				continue
			}
			song = candidate
			bestMatchScore = matchScore
		}
	}
	if song.URL == "" {
		result.err = errLyricsNotFound
		return result
	}

	lyrics, err := session.scrapeLyrics(ctx, song.URL)
	if err != nil {
		result.err = sanitizeProxyError(err, h.GeniusProxyURL)
		return result
	}
	payload := geniusLyricsResult{
		ID:          song.ID,
		Name:        song.Title,
		PlainLyrics: lyrics,
		TrackName:   song.Title,
		ArtistName:  song.ArtistNames,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		result.err = err
		return result
	}
	if h.isSearch(query) {
		body = append(append([]byte{'['}, body...), ']')
	}

	result.status = http.StatusOK
	result.header = http.Header{"Content-Type": []string{"application/json; charset=utf-8"}}
	result.body = body
	return result
}

func cleanLyricsSearchTerm(value string) string {
	value = versionTagPattern.ReplaceAllString(value, " ")
	var cleaned strings.Builder
	for _, r := range value {
		if r == '\u200d' || r == '\u20e3' || r == '\ufe0f' || unicode.Is(unicode.So, r) || unicode.Is(unicode.Sk, r) {
			cleaned.WriteByte(' ')
			continue
		}
		cleaned.WriteRune(r)
	}
	return strings.Join(strings.Fields(cleaned.String()), " ")
}

func geniusMetadataMatchScore(song geniusSong, requestedTitle, requestedArtist string) int {
	if requestedArtist == "" {
		return geniusTitleMatchScore(song.Title, requestedTitle)
	}
	wanted := comparableLyricsMetadata(requestedArtist)
	actual := comparableLyricsMetadata(song.ArtistNames)
	if wanted == "" || actual == "" || (!strings.Contains(actual, wanted) && !strings.Contains(wanted, actual)) {
		return 0
	}
	return geniusTitleMatchScore(song.Title, requestedTitle)
}

func geniusTitleMatchScore(actual, requested string) int {
	if comparableLyricsTitle(actual) == comparableLyricsTitle(requested) {
		return 200
	}
	actualBase := comparableLyricsTitle(trailingTitleQualifierPattern.ReplaceAllString(actual, ""))
	requestedBase := comparableLyricsTitle(trailingTitleQualifierPattern.ReplaceAllString(requested, ""))
	if actualBase != "" && actualBase == requestedBase {
		return 100
	}
	return 0
}

func comparableLyricsTitle(value string) string {
	return comparableLyricsMetadata(featuredTitleSuffixPattern.ReplaceAllString(value, ""))
}

func comparableLyricsMetadata(value string) string {
	value = cleanLyricsSearchTerm(value)
	var comparable strings.Builder
	space := false
	for _, r := range norm.NFKD.String(strings.ToLower(value)) {
		switch {
		case unicode.Is(unicode.Mn, r):
			continue
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			if space && comparable.Len() > 0 {
				comparable.WriteByte(' ')
			}
			comparable.WriteRune(r)
			space = false
		default:
			space = true
		}
	}
	return comparable.String()
}

func (h *Lyrics) newGeniusSession() (*geniusSession, error) {
	// Tests keep using the injected standard client. Production Genius requests
	// use a browser-like TLS/HTTP2 fingerprint, including when GENIUS_BASE is set.
	if h.Client != nil {
		return &geniusSession{standard: h.httpClient()}, nil
	}
	jar := tlsclient.NewCookieJar()
	clientOptions := []tlsclient.HttpClientOption{
		tlsclient.WithTimeoutSeconds(10),
		tlsclient.WithClientProfile(profiles.Chrome_146),
		tlsclient.WithRandomTLSExtensionOrder(),
		tlsclient.WithCookieJar(jar),
	}
	if h.GeniusProxyURL != "" {
		clientOptions = append(
			clientOptions,
			tlsclient.WithProxyUrl(h.GeniusProxyURL),
			tlsclient.WithDisableHttp3(),
		)
	}
	client, err := tlsclient.NewHttpClient(tlsclient.NewNoopLogger(), clientOptions...)
	if err != nil {
		return nil, fmt.Errorf("create Genius TLS client: %w", sanitizeProxyError(err, h.GeniusProxyURL))
	}
	return &geniusSession{tls: client}, nil
}

func sanitizeProxyError(err error, proxyURL string) error {
	if err == nil || proxyURL == "" {
		return err
	}
	return errors.New(strings.ReplaceAll(err.Error(), proxyURL, "[configured proxy]"))
}

func (s *geniusSession) getJSON(ctx context.Context, target string, destination any) error {
	status, body, err := s.get(ctx, target, "application/json", false)
	if err != nil {
		return err
	}
	defer body.Close()
	if status < 200 || status >= 300 {
		return fmt.Errorf("upstream status %d", status)
	}
	return json.NewDecoder(io.LimitReader(body, maxLyricsBody)).Decode(destination)
}

func (s *geniusSession) scrapeLyrics(ctx context.Context, target string) (string, error) {
	status, body, err := s.get(ctx, target, "text/html,application/xhtml+xml", true)
	if err != nil {
		return "", err
	}
	defer body.Close()
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("song page status %d", status)
	}

	doc, err := html.Parse(io.LimitReader(body, maxLyricsBody))
	if err != nil {
		return "", err
	}
	var containers []string
	var walk func(*html.Node)
	walk = func(node *html.Node) {
		if node.Type == html.ElementNode && hasAttr(node, "data-lyrics-container", "true") {
			var text bytes.Buffer
			collectGeniusText(&text, node)
			if value := cleanLyricsText(text.String()); value != "" {
				containers = append(containers, value)
			}
			return
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(doc)
	if len(containers) == 0 {
		return "", errLyricsNotFound
	}
	return strings.Join(containers, "\n"), nil
}

func (s *geniusSession) get(ctx context.Context, target, accept string, document bool) (int, io.ReadCloser, error) {
	var lastErr error
	for attempt := range 2 {
		status, body, err := s.getOnce(ctx, target, accept, document)
		if err == nil {
			return status, body, nil
		}
		lastErr = err
		if ctx.Err() != nil || attempt == 1 {
			break
		}
		if s.tls != nil {
			s.tls.CloseIdleConnections()
		}
	}
	return 0, nil, lastErr
}

func (s *geniusSession) getOnce(ctx context.Context, target, accept string, document bool) (int, io.ReadCloser, error) {
	if s.standard != nil {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return 0, nil, err
		}
		req.Header.Set("User-Agent", geniusUserAgent)
		req.Header.Set("Accept", accept)
		resp, err := s.standard.Do(req)
		if err != nil {
			return 0, nil, err
		}
		return resp.StatusCode, resp.Body, nil
	}

	req, err := fhttp.NewRequestWithContext(ctx, fhttp.MethodGet, target, nil)
	if err != nil {
		return 0, nil, err
	}
	destination := "empty"
	mode := "cors"
	if document {
		destination = "document"
		mode = "navigate"
	}
	req.Header = fhttp.Header{
		"accept":                    {accept},
		"accept-language":           {"en-US,en;q=0.9"},
		"cache-control":             {"no-cache"},
		"pragma":                    {"no-cache"},
		"priority":                  {"u=0, i"},
		"referer":                   {defaultGeniusBase + "/"},
		"sec-ch-ua":                 {`"Chromium";v="146", "Not_A Brand";v="99"`},
		"sec-ch-ua-mobile":          {"?0"},
		"sec-ch-ua-platform":        {`"macOS"`},
		"sec-fetch-dest":            {destination},
		"sec-fetch-mode":            {mode},
		"sec-fetch-site":            {"same-origin"},
		"upgrade-insecure-requests": {"1"},
		"user-agent":                {geniusUserAgent},
		fhttp.HeaderOrderKey:        {"accept", "accept-language", "cache-control", "pragma", "priority", "referer", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "upgrade-insecure-requests", "user-agent"},
	}
	resp, err := s.tls.Do(req)
	if err != nil {
		return 0, nil, err
	}
	return resp.StatusCode, resp.Body, nil
}

func hasAttr(node *html.Node, key, value string) bool {
	for _, attr := range node.Attr {
		if attr.Key == key && attr.Val == value {
			return true
		}
	}
	return false
}

func collectGeniusText(dst *bytes.Buffer, node *html.Node) {
	if node.Type == html.ElementNode && hasAttr(node, "data-exclude-from-selection", "true") {
		return
	}
	if node.Type == html.TextNode {
		dst.WriteString(node.Data)
		return
	}
	if node.Type == html.ElementNode && node.Data == "br" {
		dst.WriteByte('\n')
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		collectGeniusText(dst, child)
	}
}

func cleanLyricsText(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	lines := strings.Split(value, "\n")
	for i := range lines {
		lines[i] = strings.TrimSpace(lines[i])
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func copyLyricsHeaders(dst, src http.Header) {
	for key, values := range src {
		if strings.EqualFold(key, "content-encoding") ||
			strings.EqualFold(key, "transfer-encoding") ||
			strings.EqualFold(key, "connection") ||
			strings.EqualFold(key, "content-length") {
			continue
		}
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}
