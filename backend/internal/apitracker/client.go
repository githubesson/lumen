package apitracker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/githubesson/lumen/internal/httpx"
	"github.com/githubesson/lumen/internal/sourceurl"
)

const DefaultBaseURL = "https://trackers.musicfiles.su/api"

type Client struct {
	HTTP    *http.Client
	BaseURL string
}

type Tracker struct {
	ID             int64    `json:"id"`
	Row            int64    `json:"row"`
	TrackerName    string   `json:"tracker_name"`
	TrackerNameRaw string   `json:"tracker_name_raw"`
	Flags          []string `json:"flags"`
	Credits        string   `json:"credits"`
	CreditURL      string   `json:"credit_url"`
	UpToDate       string   `json:"up_to_date"`
	WorkingLinks   string   `json:"working_links"`
	URL            string   `json:"url"`
	OriginalURL    string   `json:"original_url"`
	ResourceType   string   `json:"resource_type"`
	ResourceID     string   `json:"resource_id"`
	SpreadsheetID  string   `json:"spreadsheet_id"`
	GID            string   `json:"gid"`
	EntryCount     int64    `json:"entry_count"`
}

type Era struct {
	Era      string `json:"era"`
	EraKey   string `json:"era_key"`
	ImageID  int64  `json:"image_id"`
	ImageURL string `json:"image_url"`
}

type Entry struct {
	ID               int64          `json:"id"`
	TrackerID        int64          `json:"tracker_id"`
	TrackerName      string         `json:"tracker_name"`
	TrackerURL       string         `json:"tracker_url"`
	SheetID          int64          `json:"sheet_id"`
	SheetName        string         `json:"sheet_name"`
	RowNumber        int64          `json:"row_number"`
	Era              any            `json:"era,omitempty"`
	RecEra           any            `json:"rec_era,omitempty"`
	RelEra           any            `json:"rel_era,omitempty"`
	Name             any            `json:"name,omitempty"`
	Notes            any            `json:"notes,omitempty"`
	Length           any            `json:"length,omitempty"`
	FileDate         any            `json:"file_date,omitempty"`
	LeakDate         any            `json:"leak_date,omitempty"`
	Type             any            `json:"type,omitempty"`
	Portion          any            `json:"portion,omitempty"`
	Quality          any            `json:"quality,omitempty"`
	Links            []string       `json:"links"`
	Raw              map[string]any `json:"raw"`
	Fields           map[string]any `json:"fields"`
	LessCommonFields map[string]any `json:"less_common_fields,omitempty"`
}

type entriesPage struct {
	Items  []Entry `json:"items"`
	Limit  int     `json:"limit"`
	Offset int     `json:"offset"`
	Total  int     `json:"total"`
}

type erasPage struct {
	Items []Era `json:"items"`
	Total int   `json:"total"`
}

func NewClient(baseURL string) *Client {
	return &Client{
		HTTP:    &http.Client{Timeout: 45 * time.Second},
		BaseURL: NormalizeBaseURL(baseURL),
	}
}

func (c *Client) FetchTracker(ctx context.Context, id int64) (Tracker, error) {
	if id <= 0 {
		return Tracker{}, fmt.Errorf("tracker id must be positive")
	}
	u := c.apiURL("/v1/trackers/" + strconv.FormatInt(id, 10))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return Tracker{}, err
	}
	setHeaders(req)
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return Tracker{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return Tracker{}, fmt.Errorf("api tracker fetch %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var tracker Tracker
	if err := decodeJSON(resp.Body, &tracker); err != nil {
		return Tracker{}, err
	}
	return tracker, nil
}

func (c *Client) FetchEntries(ctx context.Context, trackerID int64) ([]Entry, error) {
	const limit = 500
	offset := 0
	out := []Entry{}
	for {
		page, err := c.fetchEntriesPage(ctx, trackerID, limit, offset)
		if err != nil {
			return nil, err
		}
		out = append(out, page.Items...)
		if len(page.Items) == 0 || len(page.Items) < limit {
			break
		}
		offset += len(page.Items)
		if page.Total > 0 && offset >= page.Total {
			break
		}
	}
	return out, nil
}

func (c *Client) FetchEras(ctx context.Context, trackerID int64) ([]Era, error) {
	if trackerID <= 0 {
		return nil, fmt.Errorf("tracker id must be positive")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.apiURL("/v1/trackers/"+strconv.FormatInt(trackerID, 10)+"/eras"), nil)
	if err != nil {
		return nil, err
	}
	setHeaders(req)
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("api tracker eras %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var page erasPage
	if err := decodeJSON(resp.Body, &page); err != nil {
		return nil, err
	}
	return page.Items, nil
}

func (c *Client) FetchEraImage(ctx context.Context, imageID int64) ([]byte, string, error) {
	if imageID <= 0 {
		return nil, "", fmt.Errorf("image id must be positive")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.apiURL("/v1/era-images/"+strconv.FormatInt(imageID, 10)), nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Accept", "image/*")
	req.Header.Set("User-Agent", httpx.BrowserUserAgent)
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", fmt.Errorf("api tracker era image %s", resp.Status)
	}
	contentType := strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0])
	if !strings.HasPrefix(strings.ToLower(contentType), "image/") {
		return nil, "", fmt.Errorf("api tracker era image returned %q", contentType)
	}
	const maxEraImageBytes = 20 << 20
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxEraImageBytes+1))
	if err != nil {
		return nil, "", err
	}
	if len(data) > maxEraImageBytes {
		return nil, "", fmt.Errorf("api tracker era image exceeds 20MiB")
	}
	return data, contentType, nil
}

func (c *Client) fetchEntriesPage(ctx context.Context, trackerID int64, limit, offset int) (entriesPage, error) {
	u, err := url.Parse(c.apiURL("/v1/trackers/" + strconv.FormatInt(trackerID, 10) + "/entries"))
	if err != nil {
		return entriesPage{}, err
	}
	q := u.Query()
	q.Set("has_links", "true")
	q.Set("limit", strconv.Itoa(limit))
	q.Set("offset", strconv.Itoa(offset))
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return entriesPage{}, err
	}
	setHeaders(req)
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return entriesPage{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return entriesPage{}, fmt.Errorf("api tracker entries %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var page entriesPage
	if err := decodeJSON(resp.Body, &page); err != nil {
		return entriesPage{}, err
	}
	return page, nil
}

func (c *Client) ResolveDownloadURL(ctx context.Context, rawURL string) (string, error) {
	return sourceurl.Resolve(ctx, rawURL, c.resolveImgurGG)
}

func (c *Client) ExpandSourceURL(ctx context.Context, rawURL string, resolveClient *http.Client) ([]string, error) {
	return sourceurl.Expand(ctx, rawURL, resolveClient)
}

func (c *Client) resolveImgurGG(ctx context.Context, id string) (string, error) {
	return sourceurl.ResolveImgurGG(ctx, id, c.httpClient())
}

func (c *Client) apiURL(p string) string {
	base := DefaultBaseURL
	if c != nil && strings.TrimSpace(c.BaseURL) != "" {
		base = NormalizeBaseURL(c.BaseURL)
	}
	return strings.TrimRight(base, "/") + "/" + strings.TrimLeft(p, "/")
}

func (c *Client) httpClient() *http.Client {
	if c != nil && c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 45 * time.Second}
}

func NormalizeBaseURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return DefaultBaseURL
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return strings.TrimRight(raw, "/")
	}
	parts := sourceurl.PathParts(u.Path)
	for i, part := range parts {
		if strings.EqualFold(part, "v1") {
			u.Path = "/" + strings.Join(parts[:i], "/")
			u.RawQuery = ""
			u.Fragment = ""
			return strings.TrimRight(u.String(), "/")
		}
	}
	u.RawQuery = ""
	u.Fragment = ""
	return strings.TrimRight(u.String(), "/")
}

func ExtractBaseURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	parts := sourceurl.PathParts(u.Path)
	for i, part := range parts {
		if strings.EqualFold(part, "v1") {
			u.Path = "/" + strings.Join(parts[:i], "/")
			u.RawQuery = ""
			u.Fragment = ""
			return NormalizeBaseURL(u.String())
		}
	}
	return ""
}

func ExtractTrackerID(raw string) int64 {
	raw = strings.Trim(strings.TrimSpace(raw), `"'`)
	if raw == "" {
		return 0
	}
	if id, err := strconv.ParseInt(raw, 10, 64); err == nil && id > 0 {
		return id
	}
	u, err := url.Parse(raw)
	if err != nil {
		return 0
	}
	if u.RawQuery != "" {
		values := u.Query()
		for _, key := range []string{"tracker_id", "tracker", "id"} {
			for _, value := range values[key] {
				if id := ExtractTrackerID(value); id > 0 {
					return id
				}
			}
		}
	}
	parts := sourceurl.PathParts(u.Path)
	for i, part := range parts {
		if strings.EqualFold(part, "trackers") && i+1 < len(parts) {
			return ExtractTrackerID(parts[i+1])
		}
	}
	return 0
}

func decodeJSON(r io.Reader, out any) error {
	dec := json.NewDecoder(r)
	dec.UseNumber()
	return dec.Decode(out)
}

func setHeaders(req *http.Request) {
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", httpx.BrowserUserAgent)
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
