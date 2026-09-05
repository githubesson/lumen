// Package sourceurl resolves the external file hosts used by tracker catalogs.
package sourceurl

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/githubesson/lumen/internal/httpx"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/lastshare"
)

const skipHost = "music.froste.lol"

// Resolve rewrites supported file-host URLs. The callback preserves the
// integration's client configuration and is only invoked for imgur.gg files.
func Resolve(ctx context.Context, rawURL string, resolveImgur func(context.Context, string) (string, error)) (string, error) {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return "", err
	}
	host := strings.ToLower(u.Hostname())
	switch {
	case lastshare.IsShareURL(rawURL):
		return "", fmt.Errorf("lastshare share could not be resolved to a file")
	case host == "pillows.su" || strings.HasSuffix(host, ".pillows.su"):
		parts := PathParts(u.Path)
		if len(parts) >= 2 && parts[0] == "f" {
			return "https://api.pillows.su/api/download/" + url.PathEscape(parts[1]), nil
		}
	case host == "imgur.gg" || strings.HasSuffix(host, ".imgur.gg"):
		id := imgurGGFileID(u)
		if id == "" {
			return rawURL, nil
		}
		return resolveImgur(ctx, id)
	}
	return rawURL, nil
}

// Expand resolves Lastshare pages to audio file URLs. The supplied client must
// enforce the same URL/IP policy as the eventual downloader; nil uses the
// default hardened download client. Other hosts pass through unchanged.
func Expand(ctx context.Context, rawURL string, resolveClient *http.Client) ([]string, error) {
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

// ResolveImgurGG uses the integration's initialized HTTP client.
func ResolveImgurGG(ctx context.Context, id string, client *http.Client) (string, error) {
	apiURL := "https://imgur.gg/api/file/" + url.PathEscape(id) + "/download"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL, nil)
	if err != nil {
		return "", err
	}
	for k, v := range imgurGGHeaders(id) {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
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

func PathParts(p string) []string {
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
	parts := PathParts(u.Path)
	if len(parts) >= 2 && parts[0] == "f" {
		return parts[1]
	}
	if len(parts) == 1 {
		return parts[0]
	}
	return ""
}

func ShouldSkipURL(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == skipHost || strings.HasSuffix(host, "."+skipHost)
}
