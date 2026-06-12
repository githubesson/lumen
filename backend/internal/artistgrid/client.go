package artistgrid

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/githubesson/lumen/internal/httpx"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/lastshare"
)

const (
	defaultTrackerAPI = "https://trackerapi-1.artistgrid.cx/get/"
	skipHost          = "music.froste.lol"
)

var invalidNameChars = strings.NewReplacer(
	"<", "_", ">", "_", ":", "_", `"`, "_", "/", "_", `\`, "_",
	"|", "_", "?", "_", "*", "_", "\n", "_", "\r", "_", "\t", "_",
)

type Client struct {
	HTTP       *http.Client
	TrackerAPI string
}

type TrackerData struct {
	Raw        map[string]any
	Name       string
	Tabs       []string
	CurrentTab string
}

type Record struct {
	EraID       string
	EraName     string
	EraExtra    string
	EraImageURL string
	Category    string
	Item        map[string]any
	ItemName    string
	URLs        []string
}

func NewClient() *Client {
	return &Client{
		HTTP: &http.Client{
			Timeout: 45 * time.Second,
		},
		TrackerAPI: defaultTrackerAPI,
	}
}

func (c *Client) Fetch(ctx context.Context, trackerID, tab string) (TrackerData, error) {
	if c == nil {
		c = NewClient()
	}
	if c.HTTP == nil {
		c.HTTP = NewClient().HTTP
	}
	base := c.TrackerAPI
	if base == "" {
		base = defaultTrackerAPI
	}
	u, err := url.Parse(base + url.PathEscape(trackerID))
	if err != nil {
		return TrackerData{}, err
	}
	if strings.TrimSpace(tab) != "" {
		q := u.Query()
		q.Set("tab", tab)
		u.RawQuery = q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return TrackerData{}, err
	}
	for k, v := range artistGridHeaders() {
		req.Header.Set(k, v)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return TrackerData{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return TrackerData{}, fmt.Errorf("artistgrid fetch %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	dec := json.NewDecoder(resp.Body)
	dec.UseNumber()
	var raw map[string]any
	if err := dec.Decode(&raw); err != nil {
		return TrackerData{}, err
	}
	return TrackerData{
		Raw:        raw,
		Name:       stringField(raw, "name"),
		Tabs:       stringSlice(raw["tabs"]),
		CurrentTab: stringField(raw, "current_tab"),
	}, nil
}

func (d TrackerData) Records() []Record {
	eras, _ := d.Raw["eras"].(map[string]any)
	if len(eras) == 0 {
		return nil
	}
	out := []Record{}
	for eraID, eraAny := range eras {
		era, ok := eraAny.(map[string]any)
		if !ok {
			continue
		}
		data, _ := era["data"].(map[string]any)
		for category, itemsAny := range data {
			items, ok := itemsAny.([]any)
			if !ok {
				continue
			}
			for _, itemAny := range items {
				item, ok := itemAny.(map[string]any)
				if !ok {
					continue
				}
				urls := stringSlice(item["urls"])
				if len(urls) == 0 {
					if u := stringField(item, "url"); u != "" {
						urls = []string{u}
					}
				}
				out = append(out, Record{
					EraID:       eraID,
					EraName:     stringField(era, "name"),
					EraExtra:    stringField(era, "extra"),
					EraImageURL: stringField(era, "image"),
					Category:    category,
					Item:        item,
					ItemName:    strings.TrimSpace(stringField(item, "name")),
					URLs:        urls,
				})
			}
		}
	}
	return out
}

func (c *Client) ResolveDownloadURL(ctx context.Context, rawURL string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return "", err
	}
	host := strings.ToLower(u.Hostname())
	switch {
	case lastshare.IsShareURL(rawURL):
		// A lastshare share *page* URL should have been expanded into
		// per-file URLs upstream (see ExpandSourceURL). Reaching the
		// downloader unexpanded means expansion failed — surface it rather
		// than fetching the share's HTML landing page.
		return "", fmt.Errorf("lastshare share could not be resolved to a file")
	case host == "pillows.su" || strings.HasSuffix(host, ".pillows.su"):
		parts := pathParts(u.Path)
		if len(parts) >= 2 && parts[0] == "f" {
			return "https://api.pillows.su/api/download/" + url.PathEscape(parts[1]), nil
		}
	case host == "imgur.gg" || strings.HasSuffix(host, ".imgur.gg"):
		id := imgurGGFileID(u)
		if id == "" {
			return rawURL, nil
		}
		return c.resolveImgurGG(ctx, id)
	}
	return rawURL, nil
}

// ExpandSourceURL turns a single tracker source URL into the concrete
// download URLs it represents. Almost every URL passes through unchanged as a
// one-element slice; a lastshare share link is fetched and expanded into one
// direct URL per audio file it contains (non-audio files in the share — cover
// art, videos — are dropped here so they never enter the download pipeline).
//
// resolveClient is the HTTP client used for the lastshare resolution fetch.
// Callers MUST pass the same SSRF-hardened client used for the eventual
// download (see Scanner.downloadClient): the resolution issues a server-side
// GET to a host derived from an untrusted tracker URL, so it needs the same
// IP-level blocking as the download itself. A nil client falls back to the
// default hardened client.
func (c *Client) ExpandSourceURL(ctx context.Context, rawURL string, resolveClient *http.Client) ([]string, error) {
	if !lastshare.IsShareURL(rawURL) {
		return []string{rawURL}, nil
	}
	if resolveClient == nil {
		resolveClient = httpx.DefaultDownloadClient()
	}
	share, err := (&lastshare.Client{HTTP: resolveClient}).Resolve(ctx, rawURL)
	if err != nil {
		return nil, err
	}
	urls := make([]string, 0, len(share.Files))
	for _, f := range share.Files {
		if ingest.IsSupported(f.Name) {
			urls = append(urls, f.DownloadURL)
		}
	}
	if len(urls) == 0 {
		return nil, fmt.Errorf("lastshare share %s contains no audio files", share.ID)
	}
	return urls, nil
}

func (c *Client) resolveImgurGG(ctx context.Context, id string) (string, error) {
	if c == nil {
		c = NewClient()
	}
	if c.HTTP == nil {
		c.HTTP = NewClient().HTTP
	}
	apiURL := "https://imgur.gg/api/file/" + url.PathEscape(id) + "/download"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL, nil)
	if err != nil {
		return "", err
	}
	for k, v := range imgurGGHeaders(id) {
		req.Header.Set(k, v)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", fmt.Errorf("imgur.gg resolve %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var parsed struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return "", err
	}
	if strings.TrimSpace(parsed.URL) == "" {
		return "", fmt.Errorf("imgur.gg returned no download URL")
	}
	return parsed.URL, nil
}

func ExtractTrackerID(raw string) string {
	raw = strings.Trim(strings.TrimSpace(raw), `"'`)
	if raw == "" {
		return ""
	}
	if strings.Contains(raw, "://") || strings.HasPrefix(raw, "/") {
		return extractTrackerIDFromURL(raw)
	}
	if strings.Contains(raw, "=") {
		if id := trackerIDFromValues(raw); id != "" {
			return id
		}
	}
	return raw
}

func ValidTrackerID(id string) bool {
	id = strings.TrimSpace(id)
	return id != "" && !reservedTrackerID(id)
}

func extractTrackerIDFromURL(raw string) string {
	parseRaw := raw
	if strings.HasPrefix(parseRaw, "/") {
		parseRaw = "https://artistgrid.cx" + parseRaw
	}
	u, err := url.Parse(parseRaw)
	if err != nil {
		return ""
	}
	if id := trackerIDFromValues(u.RawQuery); id != "" {
		return id
	}
	parts := pathParts(u.Path)
	for i, part := range parts {
		lower := strings.ToLower(part)
		if lower == "spreadsheets" && i+2 < len(parts) && strings.EqualFold(parts[i+1], "d") {
			return parts[i+2]
		}
		if lower == "d" && strings.Contains(strings.ToLower(u.Hostname()), "docs.google.") && i+1 < len(parts) {
			return parts[i+1]
		}
		if routeTrackerSegment(lower) && i+1 < len(parts) {
			return parts[i+1]
		}
	}
	if len(parts) > 0 {
		last := parts[len(parts)-1]
		if ValidTrackerID(last) {
			return last
		}
	}
	if u.Fragment != "" {
		frag := strings.TrimSpace(u.Fragment)
		if strings.Contains(frag, "/") || strings.Contains(frag, "?") || strings.Contains(frag, "://") {
			if !strings.Contains(frag, "://") {
				if strings.HasPrefix(frag, "/") {
					frag = "https://artistgrid.cx" + frag
				} else {
					frag = "https://artistgrid.cx/" + frag
				}
			}
			if id := extractTrackerIDFromURL(frag); id != "" {
				return id
			}
		}
	}
	return ""
}

func trackerIDFromValues(rawQuery string) string {
	values, err := url.ParseQuery(strings.TrimPrefix(rawQuery, "?"))
	if err != nil {
		return ""
	}
	for _, key := range []string{"id", "tracker", "tracker_id", "sheet", "sheet_id", "spreadsheet", "spreadsheet_id"} {
		for _, value := range values[key] {
			value = strings.TrimSpace(value)
			if ValidTrackerID(value) {
				return value
			}
		}
	}
	for _, key := range []string{"url", "u"} {
		for _, value := range values[key] {
			if id := ExtractTrackerID(value); id != "" {
				return id
			}
		}
	}
	return ""
}

func routeTrackerSegment(part string) bool {
	switch part {
	case "view", "tracker", "trackers", "sheet", "sheets", "grid":
		return true
	default:
		return false
	}
}

func reservedTrackerID(id string) bool {
	switch strings.ToLower(strings.TrimSpace(id)) {
	case "view", "tracker", "trackers", "sheet", "sheets", "grid", "edit", "copy", "export":
		return true
	default:
		return false
	}
}

func ShouldSkipURL(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == skipHost || strings.HasSuffix(host, "."+skipHost)
}

func SanitizeName(name string) string {
	name = invalidNameChars.Replace(strings.TrimSpace(name))
	name = strings.Trim(name, ". ")
	if len(name) > 180 {
		name = name[:180]
	}
	if name == "" {
		return "unnamed"
	}
	return name
}

func PickFilename(resp *http.Response, finalURL string, fallback string) string {
	if cd := resp.Header.Get("Content-Disposition"); cd != "" {
		if _, params, err := mime.ParseMediaType(cd); err == nil {
			if name := strings.TrimSpace(params["filename"]); name != "" {
				return SanitizeName(name)
			}
			if name := strings.TrimSpace(params["filename*"]); name != "" {
				return SanitizeName(name)
			}
		}
	}
	if u, err := url.Parse(finalURL); err == nil {
		if base := path.Base(u.Path); base != "." && strings.Contains(base, ".") {
			if unescaped, err := url.PathUnescape(base); err == nil {
				return SanitizeName(unescaped)
			}
			return SanitizeName(base)
		}
	}
	ct := strings.ToLower(strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0]))
	return SanitizeName(fallback) + contentTypeExt(ct)
}

func BuildContext(data TrackerData, pin Pin, tab string, rec Record) TrackContext {
	primary := strings.TrimSpace(pin.PrimaryArtist)
	if primary == "" {
		primary = GuessPrimaryArtist(data.Name)
	}
	rawTitle := strings.TrimSpace(rec.ItemName)
	if rawTitle == "" {
		rawTitle = "Unknown"
	}
	extra := stringField(rec.Item, "extra")
	producer, altTitle, featured := ParseExtra(extra)
	year := ParseYear(rec.EraExtra)
	if year == 0 {
		year = ParseYear(stringField(rec.Item, "file_date"))
	}
	artist := primary
	if len(featured) > 0 {
		artist = primary + " feat. " + strings.Join(featured, ", ")
	}
	commentParts := []string{}
	if desc := strings.TrimSpace(stringField(rec.Item, "description")); desc != "" {
		commentParts = append(commentParts, desc)
	}
	if altTitle != "" {
		commentParts = append(commentParts, "Alt title: "+altTitle)
	}
	return TrackContext{
		Title:       rawTitle,
		Artist:      artist,
		AlbumArtist: primary,
		Album:       strings.TrimSpace(rec.EraName),
		Year:        year,
		Genre:       tab,
		Composer:    producer,
		Comment:     strings.Join(commentParts, "\n\n"),
		Featured:    featured,
		CoverURL:    rec.EraImageURL,
		Custom: map[string]string{
			"TRACKER":                  data.Name,
			"TRACKER_TAB":              tab,
			"TRACKER_ERA":              rec.EraName,
			"TRACKER_ERA_EXTRA":        rec.EraExtra,
			"TRACKER_CATEGORY":         rec.Category,
			"TRACKER_TYPE":             stringField(rec.Item, "type"),
			"TRACKER_AVAILABLE_LENGTH": stringField(rec.Item, "available_length"),
			"TRACKER_QUALITY":          stringField(rec.Item, "quality"),
			"TRACKER_LEAK_DATE":        stringField(rec.Item, "leak_date"),
			"TRACKER_FILE_DATE":        stringField(rec.Item, "file_date"),
			"TRACKER_TRACK_LENGTH":     stringField(rec.Item, "track_length"),
			"TRACKER_EXTRA":            extra,
			"TRACKER_ALT_TITLE":        altTitle,
			"TRACKER_ORIGINAL_NAME":    rawTitle,
		},
	}
}

type TrackContext struct {
	Title       string
	Artist      string
	AlbumArtist string
	Album       string
	Year        int
	Genre       string
	Composer    string
	Comment     string
	Featured    []string
	Custom      map[string]string
	CoverURL    string
}

func GuessPrimaryArtist(trackerName string) string {
	name := strings.TrimSpace(trackerName)
	for _, suffix := range []string{"Track\u00ebr", "Tracker", "Grid", "Sheet", "Spreadsheet", "List", "Leaks", "Archive", "Database"} {
		lowerName := strings.ToLower(name)
		lowerSuffix := strings.ToLower(suffix)
		if strings.HasSuffix(lowerName, " "+lowerSuffix) {
			return strings.TrimSpace(name[:len(name)-len(suffix)-1])
		}
		if strings.HasSuffix(lowerName, lowerSuffix) {
			return strings.TrimSpace(name[:len(name)-len(suffix)])
		}
	}
	return name
}

// Regexes used by the scan hot path; compiled once at package init rather
// than on every record.
var (
	yearCopyrightRe = regexp.MustCompile(`(?:\x{2117}|\x{00a9})\s*(\d{4})`)
	yearPlainRe     = regexp.MustCompile(`\b(?:19|20)\d{2}\b`)
	extraGroupRe    = regexp.MustCompile(`\(([^()]+)\)`)
	extraProdRe     = regexp.MustCompile(`(?i)^(?:prod\.?|produced by)\b\s*`)
	extraFeatRe     = regexp.MustCompile(`(?i)^(?:feat\.?|ft\.?|featuring|w/|with)\b\s*`)
)

func ParseYear(text string) int {
	if text == "" {
		return 0
	}
	if m := yearCopyrightRe.FindStringSubmatch(text); len(m) == 2 {
		if y, err := strconv.Atoi(m[1]); err == nil {
			return y
		}
	}
	if m := yearPlainRe.FindString(text); m != "" {
		if y, err := strconv.Atoi(m); err == nil {
			return y
		}
	}
	return 0
}

func ParseExtra(extra string) (producer string, altTitle string, featured []string) {
	if extra == "" {
		return "", "", nil
	}
	for _, m := range extraGroupRe.FindAllStringSubmatch(extra, -1) {
		if len(m) < 2 {
			continue
		}
		group := strings.TrimSpace(m[1])
		if group == "" {
			continue
		}
		switch {
		case extraProdRe.MatchString(group):
			producer = strings.TrimSpace(extraProdRe.ReplaceAllString(group, ""))
		case extraFeatRe.MatchString(group):
			f := strings.TrimSpace(extraFeatRe.ReplaceAllString(group, ""))
			if f != "" {
				featured = append(featured, f)
			}
		case altTitle == "":
			altTitle = group
		}
	}
	return producer, altTitle, featured
}

func artistGridHeaders() map[string]string {
	return map[string]string{
		"Accept":          "*/*",
		"Accept-Language": "en-US,en;q=0.9",
		"Origin":          "https://artistgrid.cx",
		"Referer":         "https://artistgrid.cx/",
		"User-Agent":      httpx.BrowserUserAgent,
	}
}

func imgurGGHeaders(id string) map[string]string {
	return map[string]string{
		"Accept":          "*/*",
		"Accept-Language": "en-US,en;q=0.9",
		"Content-Type":    "application/json",
		"Origin":          "https://imgur.gg",
		"Referer":         "https://imgur.gg/f/" + id,
		"User-Agent":      httpx.BrowserUserAgent,
	}
}

func pathParts(p string) []string {
	raw := strings.Split(strings.Trim(p, "/"), "/")
	out := raw[:0]
	for _, part := range raw {
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func imgurGGFileID(u *url.URL) string {
	parts := pathParts(u.Path)
	if len(parts) >= 2 && parts[0] == "f" {
		return parts[1]
	}
	if len(parts) == 1 {
		return parts[0]
	}
	return ""
}

func stringField(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	return anyString(m[key])
}

func stringSlice(v any) []string {
	switch x := v.(type) {
	case []any:
		out := make([]string, 0, len(x))
		for _, item := range x {
			if s := strings.TrimSpace(anyString(item)); s != "" {
				out = append(out, s)
			}
		}
		return out
	case []string:
		out := make([]string, 0, len(x))
		for _, item := range x {
			if s := strings.TrimSpace(item); s != "" {
				out = append(out, s)
			}
		}
		return out
	case string:
		if strings.TrimSpace(x) == "" {
			return nil
		}
		return []string{x}
	}
	return nil
}

func anyString(v any) string {
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x)
	case json.Number:
		return x.String()
	case float64:
		if x == float64(int64(x)) {
			return strconv.FormatInt(int64(x), 10)
		}
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	case nil:
		return ""
	default:
		return strings.TrimSpace(fmt.Sprint(x))
	}
}

func contentTypeExt(ct string) string {
	switch ct {
	case "audio/mpeg", "audio/mp3":
		return ".mp3"
	case "audio/flac", "audio/x-flac":
		return ".flac"
	case "audio/wav", "audio/x-wav":
		return ".wav"
	case "audio/ogg":
		return ".ogg"
	case "audio/mp4":
		return ".m4a"
	case "audio/aac":
		return ".aac"
	case "audio/webm":
		return ".webm"
	case "video/mp4":
		return ".mp4"
	case "video/quicktime":
		return ".mov"
	case "video/webm":
		return ".webm"
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "application/zip":
		return ".zip"
	}
	return ""
}
