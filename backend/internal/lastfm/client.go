package lastfm

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultAPIURL  = "https://ws.audioscrobbler.com/2.0/"
	DefaultAuthURL = "https://www.last.fm/api/auth/"
)

type Config struct {
	APIKey       string
	SharedSecret string
	APIURL       string
	AuthURL      string
	HTTPClient   *http.Client
}

type Client struct {
	apiKey       string
	sharedSecret string
	apiURL       string
	authURL      string
	http         *http.Client
}

type APIError struct {
	Code    int
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("last.fm error %d: %s", e.Code, e.Message)
}

type Session struct {
	Username string
	Key      string
}

type Track struct {
	Artist      string
	Title       string
	Album       string
	AlbumArtist string
	TrackNumber int
	DurationSec int
	StartedAt   time.Time
}

func NewClient(cfg Config) *Client {
	apiURL := strings.TrimSpace(cfg.APIURL)
	if apiURL == "" {
		apiURL = DefaultAPIURL
	}
	authURL := strings.TrimSpace(cfg.AuthURL)
	if authURL == "" {
		authURL = DefaultAuthURL
	}
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 12 * time.Second}
	}
	return &Client{
		apiKey:       strings.TrimSpace(cfg.APIKey),
		sharedSecret: strings.TrimSpace(cfg.SharedSecret),
		apiURL:       apiURL,
		authURL:      authURL,
		http:         httpClient,
	}
}

func (c *Client) Configured() bool {
	return c != nil && c.apiKey != "" && c.sharedSecret != ""
}

func (c *Client) AuthorizationURL(token string) string {
	u, _ := url.Parse(c.authURL)
	q := u.Query()
	q.Set("api_key", c.apiKey)
	q.Set("token", token)
	u.RawQuery = q.Encode()
	return u.String()
}

func (c *Client) GetToken(ctx context.Context) (string, error) {
	var out struct {
		Token string `json:"token"`
	}
	if err := c.call(ctx, url.Values{"method": {"auth.getToken"}}, &out); err != nil {
		return "", err
	}
	if out.Token == "" {
		return "", fmt.Errorf("last.fm returned an empty auth token")
	}
	return out.Token, nil
}

func (c *Client) GetSession(ctx context.Context, token string) (Session, error) {
	var out struct {
		Session struct {
			Name string `json:"name"`
			Key  string `json:"key"`
		} `json:"session"`
	}
	err := c.call(ctx, url.Values{
		"method": {"auth.getSession"},
		"token":  {token},
	}, &out)
	return Session{Username: out.Session.Name, Key: out.Session.Key}, err
}

func (c *Client) UpdateNowPlaying(ctx context.Context, sessionKey string, track Track) error {
	params := trackParams(track)
	params.Set("method", "track.updateNowPlaying")
	params.Set("sk", sessionKey)
	return c.call(ctx, params, &struct{}{})
}

func (c *Client) Scrobble(ctx context.Context, sessionKey string, track Track) error {
	params := trackParams(track)
	params.Set("method", "track.scrobble")
	params.Set("sk", sessionKey)
	params.Set("timestamp", strconv.FormatInt(track.StartedAt.UTC().Unix(), 10))
	params.Set("chosenByUser", "1")
	return c.call(ctx, params, &struct{}{})
}

func trackParams(track Track) url.Values {
	params := url.Values{
		"artist": {track.Artist},
		"track":  {track.Title},
	}
	if track.Album != "" {
		params.Set("album", track.Album)
	}
	if track.AlbumArtist != "" {
		params.Set("albumArtist", track.AlbumArtist)
	}
	if track.TrackNumber > 0 {
		params.Set("trackNumber", strconv.Itoa(track.TrackNumber))
	}
	if track.DurationSec > 0 {
		params.Set("duration", strconv.Itoa(track.DurationSec))
	}
	return params
}

func (c *Client) call(ctx context.Context, params url.Values, out any) error {
	if !c.Configured() {
		return fmt.Errorf("last.fm is not configured")
	}
	params.Set("api_key", c.apiKey)
	params.Set("api_sig", signature(params, c.sharedSecret))
	params.Set("format", "json")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.apiURL, strings.NewReader(params.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", "Lumen/0.1 (self-hosted music library)")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	var apiErr struct {
		Error   int    `json:"error"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(body, &apiErr)
	if apiErr.Error != 0 {
		return &APIError{Code: apiErr.Error, Message: apiErr.Message}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("last.fm returned HTTP %d", resp.StatusCode)
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode last.fm response: %w", err)
	}
	return nil
}

func signature(params url.Values, secret string) string {
	keys := make([]string, 0, len(params))
	for key := range params {
		if key != "format" && key != "callback" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	var raw strings.Builder
	for _, key := range keys {
		raw.WriteString(key)
		raw.WriteString(params.Get(key))
	}
	raw.WriteString(secret)
	sum := md5.Sum([]byte(raw.String()))
	return hex.EncodeToString(sum[:])
}
