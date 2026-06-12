// Package lastshare resolves lastshare.org (a Pingvin Share instance) share
// links into direct, per-file download URLs. It exists so the artistgrid
// download pipeline can treat a lastshare link found in a tracker like any
// other download URL: one tracker URL fans out into one URL per audio file
// the share contains.
package lastshare

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

	"github.com/uncut/lumen/internal/httpx"
)

// shareHost is the only host treated as a lastshare instance. Detection is
// deliberately narrow — mirroring how the artistgrid resolver hardcodes
// imgur.gg / pillows.su rather than guessing from URL shape.
const shareHost = "lastshare.org"

// ShareFile is one file inside a lastshare share.
type ShareFile struct {
	ID           string
	Name         string
	Size         int64
	RelativePath string
	// DownloadURL is the lastshare API endpoint that 302-redirects to a
	// short-lived pre-signed storage URL. It is keyed on the file id, so it
	// is stable across scans and safe to use as a dedup key.
	DownloadURL string
}

// Share is the subset of a lastshare share document the downloader needs.
type Share struct {
	ID    string
	Name  string
	Files []ShareFile
}

// Client fetches share documents from a lastshare instance.
type Client struct {
	HTTP *http.Client
}

// IsShareURL reports whether raw is a lastshare share *page* URL. It does not
// match the /api/shares/.../files/... URLs this package emits, so resolved
// per-file URLs flow through the rest of the download pipeline untouched.
func IsShareURL(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host != shareHost && !strings.HasSuffix(host, "."+shareHost) {
		return false
	}
	return ParseShareID(raw) != ""
}

// ParseShareID extracts the share id from a lastshare share page URL
// (/share/{id}, /s/{id}, /d/{id}, /embed/share/{id}), or "" if raw is not
// one. It does not check the host, so it also works against test servers.
func ParseShareID(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	parts := pathParts(u.Path)
	if len(parts) >= 3 && strings.ToLower(parts[0]) == "embed" &&
		strings.ToLower(parts[1]) == "share" {
		return validID(parts[2])
	}
	if len(parts) >= 2 {
		switch strings.ToLower(parts[0]) {
		case "share", "s", "d":
			return validID(parts[1])
		}
	}
	return ""
}

// Resolve fetches the share referenced by a lastshare share page URL and
// returns it with every file's direct download URL populated. The host is
// not validated here — callers gate on [IsShareURL] first.
func (c *Client) Resolve(ctx context.Context, shareURL string) (Share, error) {
	shareID := ParseShareID(shareURL)
	if shareID == "" {
		return Share{}, fmt.Errorf("not a lastshare share URL")
	}
	base := baseURL(shareURL)
	api := base + "/api/shares/" + url.PathEscape(shareID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, api, nil)
	if err != nil {
		return Share{}, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", httpx.BrowserUserAgent)

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return Share{}, err
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusNotFound:
		return Share{}, fmt.Errorf("lastshare share %s not found", shareID)
	case resp.StatusCode == http.StatusUnauthorized, resp.StatusCode == http.StatusForbidden:
		return Share{}, fmt.Errorf("lastshare share %s is password protected", shareID)
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return Share{}, fmt.Errorf("lastshare fetch %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}

	var doc shareDoc
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&doc); err != nil {
		return Share{}, fmt.Errorf("lastshare decode share %s: %w", shareID, err)
	}

	share := Share{ID: shareID, Name: strings.TrimSpace(doc.Name)}
	for _, f := range doc.Files {
		id := strings.TrimSpace(f.ID)
		if id == "" {
			continue
		}
		share.Files = append(share.Files, ShareFile{
			ID:           id,
			Name:         strings.TrimSpace(f.Name),
			Size:         int64(f.Size),
			RelativePath: strings.TrimSpace(f.RelativePath),
			DownloadURL:  base + "/api/shares/" + url.PathEscape(shareID) + "/files/" + url.PathEscape(id),
		})
	}
	return share, nil
}

func (c *Client) httpClient() *http.Client {
	if c != nil && c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 45 * time.Second}
}

// shareDoc mirrors the lastshare GET /api/shares/{id} response. `size` comes
// back as a JSON string from that endpoint (but as a number elsewhere), so it
// is decoded leniently.
type shareDoc struct {
	Name  string `json:"name"`
	Files []struct {
		ID           string  `json:"id"`
		Name         string  `json:"name"`
		Size         flexInt `json:"size"`
		RelativePath string  `json:"relativePath"`
	} `json:"files"`
}

// flexInt decodes an int64 that may be encoded as either a JSON number or a
// JSON string.
type flexInt int64

func (n *flexInt) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(strings.Trim(string(b), `"`))
	if s == "" || s == "null" {
		return nil
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return err
	}
	*n = flexInt(v)
	return nil
}

func baseURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "https://" + shareHost
	}
	return u.Scheme + "://" + u.Host
}

func validID(s string) string {
	s = strings.TrimSpace(s)
	if s == "" || len(s) > 100 {
		return ""
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return ""
		}
	}
	return s
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
