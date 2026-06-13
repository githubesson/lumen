package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	HTTPAddr       string
	DatabaseURL    string
	MusicPath      string
	TranscodeCache string
	AdminUsername  string
	AdminPassword  string
	CookieName     string
	CookieSecure   bool
	SessionTTL     time.Duration
	// APITrackerBaseURL overrides the tracker-API instance the scanner's
	// default client talks to. Blank means apitracker.DefaultBaseURL.
	APITrackerBaseURL          string
	APITrackerScanPollInterval time.Duration
	APITrackerFileTimeout      time.Duration
	ArtistGridScanPollInterval time.Duration
	ArtistGridFileTimeout      time.Duration
	FilenScanPollInterval      time.Duration
	FilenFileTimeout           time.Duration
	FilenDownloaderNode        string
	FilenDownloaderScript      string
	TIDALCountryCode           string
	TIDALQuality               string
	TIDALHifiAPIURL            string
	EnableTranscoding          bool
	TrustedProxies             []string
	// CoverSignKey is the HMAC secret used to mint/verify public signed
	// cover-art URLs (for Discord Rich Presence, which fetches large_image
	// server-side and has no cookies). Set via COVER_SIGN_KEY (hex-encoded);
	// if unset, a random 32-byte key is generated at startup — signed URLs
	// rotate on each restart, but Discord just re-fetches. The same secret
	// signs share-page and preview-MP4 URLs, which have identical trust
	// properties (the signature is the auth).
	CoverSignKey []byte
	// CoverSignKeyEphemeral is true when CoverSignKey was randomly generated
	// because COVER_SIGN_KEY wasn't set. Main uses it to emit a warning.
	CoverSignKeyEphemeral bool
	// PreviewCacheDir is where generated share-preview MP4s are cached.
	// Defaults to {TranscodeCache}/previews so both transcode artifacts
	// live under a single mounted cache volume.
	PreviewCacheDir string
}

func FromEnv() (*Config, error) {
	c := &Config{
		HTTPAddr:                   getenv("HTTP_ADDR", ":8080"),
		DatabaseURL:                os.Getenv("DATABASE_URL"),
		MusicPath:                  getenv("MUSIC_PATH", "/music"),
		TranscodeCache:             getenv("TRANSCODE_CACHE", "/cache"),
		AdminUsername:              getenv("ADMIN_USERNAME", "admin"),
		AdminPassword:              os.Getenv("ADMIN_PASSWORD"),
		CookieName:                 getenv("SESSION_COOKIE", "mlsession"),
		CookieSecure:               boolenv("COOKIE_SECURE", true),
		SessionTTL:                 durenv("SESSION_TTL", 30*24*time.Hour),
		APITrackerBaseURL:          getenv("API_TRACKER_BASE_URL", ""),
		APITrackerScanPollInterval: durenv("API_TRACKER_SCAN_POLL_INTERVAL", 5*time.Minute),
		APITrackerFileTimeout:      durenv("API_TRACKER_FILE_TIMEOUT", 30*time.Minute),
		ArtistGridScanPollInterval: durenv("ARTISTGRID_SCAN_POLL_INTERVAL", 5*time.Minute),
		ArtistGridFileTimeout:      durenv("ARTISTGRID_FILE_TIMEOUT", 30*time.Minute),
		FilenScanPollInterval:      durenv("FILEN_SCAN_POLL_INTERVAL", 5*time.Minute),
		FilenFileTimeout:           durenv("FILEN_FILE_TIMEOUT", 30*time.Minute),
		FilenDownloaderNode:        getenv("FILEN_DOWNLOADER_NODE", "node"),
		FilenDownloaderScript:      getenv("FILEN_DOWNLOADER_SCRIPT", ""),
		TIDALCountryCode:           strings.ToUpper(getenv("TIDAL_COUNTRY_CODE", "US")),
		TIDALQuality:               strings.ToUpper(getenv("TIDAL_QUALITY", "LOSSLESS")),
		TIDALHifiAPIURL:            getenv("TIDAL_HIFI_API_URL", ""),
		EnableTranscoding:          boolenv("ENABLE_TRANSCODING", false),
		TrustedProxies:             splitenv("TRUSTED_PROXIES"),
	}
	if c.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	key, ephemeral, err := loadCoverSignKey()
	if err != nil {
		return nil, err
	}
	c.CoverSignKey = key
	c.CoverSignKeyEphemeral = ephemeral
	c.PreviewCacheDir = getenv("PREVIEW_CACHE", filepath.Join(c.TranscodeCache, "previews"))
	return c, nil
}

func loadCoverSignKey() ([]byte, bool, error) {
	raw := strings.TrimSpace(os.Getenv("COVER_SIGN_KEY"))
	if raw != "" {
		k, err := hex.DecodeString(raw)
		if err != nil {
			return nil, false, fmt.Errorf("COVER_SIGN_KEY must be hex-encoded: %w", err)
		}
		if len(k) < 16 {
			return nil, false, fmt.Errorf("COVER_SIGN_KEY must decode to at least 16 bytes, got %d", len(k))
		}
		return k, false, nil
	}
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		return nil, false, fmt.Errorf("generate cover sign key: %w", err)
	}
	return k, true, nil
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func boolenv(k string, def bool) bool {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

func durenv(k string, def time.Duration) time.Duration {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return def
	}
	return d
}

func splitenv(k string) []string {
	v := os.Getenv(k)
	if v == "" {
		return nil
	}
	parts := strings.Split(v, ",")
	out := parts[:0]
	for _, p := range parts {
		if s := strings.TrimSpace(p); s != "" {
			out = append(out, s)
		}
	}
	return out
}
