package tidal

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
)

// assembleHLSFile fetches the playlist at rawURL, descends into a master
// playlist if present, then streams a concatenated, decrypted body of all
// media segments.
func (c *Client) assembleHLSFile(ctx context.Context, rawURL string) (*http.Response, error) {
	if err := validateTIDALMediaURL(rawURL); err != nil {
		slog.Warn("tidal hls file url rejected", "url", logSafeURL(rawURL), "err", err)
		return nil, err
	}
	parsed, base, err := c.fetchAndParsePlaylist(ctx, rawURL)
	if err != nil {
		return nil, err
	}
	if parsed.isMaster {
		if len(parsed.variants) == 0 {
			return nil, errors.New("tidal master playlist had no variants")
		}
		variant := pickBestVariant(parsed.variants)
		variantURL := resolveHLSURI(base, variant.uri)
		if err := validateTIDALMediaURL(variantURL); err != nil {
			slog.Warn("tidal hls variant url rejected", "url", logSafeURL(variantURL), "err", err)
			return nil, err
		}
		slog.Debug("tidal hls master picked variant",
			"bandwidth", variant.bandwidth,
			"url", logSafeURL(variantURL))
		parsed, base, err = c.fetchAndParsePlaylist(ctx, variantURL)
		if err != nil {
			return nil, err
		}
		if parsed.isMaster {
			return nil, errors.New("tidal variant playlist was itself a master playlist")
		}
	}
	if len(parsed.segments) == 0 {
		return nil, errors.New("tidal media playlist had no segments")
	}

	// Fetch keys up front so resolution errors surface before streaming.
	keys := make([][]byte, len(parsed.keys))
	for i, k := range parsed.keys {
		if strings.EqualFold(k.method, "NONE") || k.method == "" {
			keys[i] = nil
			continue
		}
		if !strings.EqualFold(k.method, "AES-128") {
			return nil, fmt.Errorf("tidal hls unsupported key method %q", k.method)
		}
		keyURL := resolveHLSURI(base, k.uri)
		if err := validateTIDALMediaURL(keyURL); err != nil {
			slog.Warn("tidal hls key url rejected", "url", logSafeURL(keyURL), "err", err)
			return nil, err
		}
		keyBytes, kerr := c.fetchKey(ctx, keyURL)
		if kerr != nil {
			return nil, fmt.Errorf("tidal hls key fetch failed: %w", kerr)
		}
		keys[i] = keyBytes
	}

	contentType := hlsContentType(parsed, base)
	pr, pw := io.Pipe()
	go func() {
		err := c.streamSegments(ctx, parsed, base, keys, pw)
		if err != nil {
			_ = pw.CloseWithError(err)
			return
		}
		_ = pw.Close()
	}()

	header := http.Header{}
	header.Set("Content-Type", contentType)
	header.Set("Accept-Ranges", "none")
	header.Set("Cache-Control", "private, max-age=0")
	return &http.Response{
		StatusCode:    http.StatusOK,
		Status:        "200 OK",
		Header:        header,
		Body:          pr,
		ContentLength: -1,
	}, nil
}

// fetchAndParsePlaylist GETs rawURL and parses the body as an HLS playlist.
// The returned base URL is the playlist URL used to resolve relative URIs.
func (c *Client) fetchAndParsePlaylist(ctx context.Context, rawURL string) (parsedPlaylist, *url.URL, error) {
	resp, err := c.openStream(ctx, rawURL, nil)
	if err != nil {
		slog.Warn("tidal hls playlist fetch failed", "url", logSafeURL(rawURL), "err", err)
		return parsedPlaylist{}, nil, err
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	resp.Body.Close()
	if err != nil {
		slog.Warn("tidal hls playlist read failed", "url", logSafeURL(rawURL), "err", err)
		return parsedPlaylist{}, nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return parsedPlaylist{}, nil, fmt.Errorf("tidal hls playlist fetch failed: %s", resp.Status)
	}
	base, _ := url.Parse(rawURL)
	parsed, perr := parseHLSPlaylist(string(body))
	if perr != nil {
		return parsedPlaylist{}, nil, fmt.Errorf("tidal hls playlist parse failed: %w", perr)
	}
	return parsed, base, nil
}

// fetchKey downloads an AES-128 key (16 bytes) from keyURL.
func (c *Client) fetchKey(ctx context.Context, keyURL string) ([]byte, error) {
	resp, err := c.openStream(ctx, keyURL, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("tidal hls key fetch status %s", resp.Status)
	}
	key, err := io.ReadAll(io.LimitReader(resp.Body, 64))
	if err != nil {
		return nil, err
	}
	if len(key) != 16 {
		return nil, fmt.Errorf("tidal hls key has unexpected length %d", len(key))
	}
	return key, nil
}

// streamSegments fetches the fMP4 init section (if any) and each segment
// sequentially, decrypts AES-128-CBC segments with their associated key+IV,
// strips PKCS7 padding per segment, and writes the concatenated plaintext to
// w. The init section is written first so the assembled file has valid
// ftyp/moov boxes before the moof/mdat fragments.
func (c *Client) streamSegments(ctx context.Context, parsed parsedPlaylist, base *url.URL, keys [][]byte, w io.Writer) error {
	if parsed.initURI != "" {
		initURL := resolveHLSURI(base, parsed.initURI)
		if err := validateTIDALMediaURL(initURL); err != nil {
			slog.Warn("tidal hls init url rejected", "url", logSafeURL(initURL), "err", err)
			return err
		}
		resp, err := c.openStream(ctx, initURL, nil)
		if err != nil {
			slog.Warn("tidal hls init fetch failed", "url", logSafeURL(initURL), "err", err)
			return err
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return fmt.Errorf("tidal hls init read failed: %w", err)
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("tidal hls init status %s", resp.Status)
		}
		out := body
		if parsed.initKey >= 0 && parsed.initKey < len(keys) && keys[parsed.initKey] != nil {
			plain, derr := decryptHLSSegment(body, keys[parsed.initKey], parsed.keys[parsed.initKey].iv, 0)
			if derr != nil {
				return fmt.Errorf("tidal hls init decrypt failed: %w", derr)
			}
			out = plain
		}
		if _, err := w.Write(out); err != nil {
			return err
		}
	}
	for i, seg := range parsed.segments {
		segURL := resolveHLSURI(base, seg.uri)
		if err := validateTIDALMediaURL(segURL); err != nil {
			slog.Warn("tidal hls segment url rejected", "url", logSafeURL(segURL), "err", err)
			return err
		}
		resp, err := c.openStream(ctx, segURL, nil)
		if err != nil {
			slog.Warn("tidal hls segment fetch failed", "url", logSafeURL(segURL), "err", err)
			return err
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return fmt.Errorf("tidal hls segment read failed: %w", err)
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("tidal hls segment %d status %s", i+1, resp.Status)
		}
		out := body
		if seg.keyIndex >= 0 && seg.keyIndex < len(keys) && keys[seg.keyIndex] != nil {
			plain, derr := decryptHLSSegment(body, keys[seg.keyIndex], parsed.keys[seg.keyIndex].iv, parsed.mediaSequence+uint64(i))
			if derr != nil {
				return fmt.Errorf("tidal hls segment %d decrypt failed: %w", i+1, derr)
			}
			out = plain
		}
		if _, err := w.Write(out); err != nil {
			return err
		}
	}
	return nil
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

// ---- HLS download assembly helpers ----

type hlsVariant struct {
	uri       string
	bandwidth int64
}

type hlsKeyRef struct {
	method string
	uri    string
	iv     []byte
}

type hlsSegment struct {
	uri      string
	keyIndex int
}

type parsedPlaylist struct {
	isMaster      bool
	variants      []hlsVariant
	segments      []hlsSegment
	keys          []hlsKeyRef
	mediaSequence uint64
	// initURI is the #EXT-X-MAP URI (fMP4 initialization section). Empty for
	// non-fMP4 playlists. The init segment carries the ftyp/moov boxes that
	// make a concatenated .m4s file playable; without it the segments are
	// orphaned moof/mdat fragments.
	initURI string
	initKey int
}

func parseHLSPlaylist(body string) (parsedPlaylist, error) {
	var p parsedPlaylist
	lines := strings.Split(body, "\n")
	curKeyIndex := -1
	var pendingVariant *hlsVariant
	for _, raw := range lines {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") {
			switch {
			case strings.HasPrefix(line, "#EXT-X-MEDIA-SEQUENCE:"):
				n, _ := strconv.ParseUint(strings.TrimPrefix(line, "#EXT-X-MEDIA-SEQUENCE:"), 10, 64)
				p.mediaSequence = n
			case strings.HasPrefix(line, "#EXT-X-STREAM-INF:"):
				bw := bandwidthFromAttrs(line)
				p.isMaster = true
				pendingVariant = &hlsVariant{bandwidth: bw}
			case strings.HasPrefix(line, "#EXT-X-KEY:"):
				k, err := parseKeyAttrs(line)
				if err != nil {
					return p, err
				}
				if strings.EqualFold(k.method, "NONE") {
					curKeyIndex = -1
				} else {
					p.keys = append(p.keys, k)
					curKeyIndex = len(p.keys) - 1
				}
			case strings.HasPrefix(line, "#EXT-X-MAP:"):
				if u := mapURI(line); u != "" {
					p.initURI = u
					p.initKey = curKeyIndex
				}
			case strings.HasPrefix(line, "#EXTINF"):
				// Next non-comment line is a segment URI; handled below.
			}
			continue
		}
		if pendingVariant != nil {
			pendingVariant.uri = line
			p.variants = append(p.variants, *pendingVariant)
			pendingVariant = nil
			continue
		}
		p.segments = append(p.segments, hlsSegment{uri: line, keyIndex: curKeyIndex})
	}
	return p, nil
}

func pickBestVariant(variants []hlsVariant) hlsVariant {
	best := variants[0]
	for _, v := range variants[1:] {
		if v.bandwidth > best.bandwidth {
			best = v
		}
	}
	return best
}

func hlsContentType(parsed parsedPlaylist, base *url.URL) string {
	// The init segment (#EXT-X-MAP) is the most reliable signal for fMP4.
	if parsed.initURI != "" {
		if u, err := url.Parse(strings.TrimSpace(parsed.initURI)); err == nil {
			if base != nil {
				u = base.ResolveReference(u)
			}
			switch strings.ToLower(path.Ext(u.Path)) {
			case ".flac":
				return "audio/flac"
			case ".mp4", ".m4s", ".cmfa", ".cmfv", ".init":
				return "audio/mp4"
			}
		}
		return "audio/mp4"
	}
	for _, seg := range parsed.segments {
		u, err := url.Parse(strings.TrimSpace(seg.uri))
		if err != nil {
			continue
		}
		if base != nil {
			u = base.ResolveReference(u)
		}
		ext := strings.ToLower(path.Ext(u.Path))
		switch ext {
		case ".flac":
			return "audio/flac"
		case ".ts", ".m2t":
			return "video/mp2t"
		case ".mp4", ".m4s", ".aac", ".cmfa", ".cmfv":
			return "audio/mp4"
		case ".ogg", ".oga":
			return "audio/ogg"
		case ".wav":
			return "audio/wav"
		}
	}
	return "audio/mp4"
}

func decryptHLSSegment(ciphertext, key, iv []byte, mediaSeq uint64) ([]byte, error) {
	if len(key) != 16 {
		return nil, fmt.Errorf("aes key length %d", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	var ivBytes [16]byte
	if len(iv) == 16 {
		copy(ivBytes[:], iv)
	} else {
		// HLS default IV: 128-bit big-endian media sequence number.
		for i := 0; i < 16; i++ {
			ivBytes[15-i] = byte(mediaSeq >> (8 * i))
		}
	}
	if len(ciphertext)%block.BlockSize() != 0 {
		return nil, fmt.Errorf("ciphertext length %d not a multiple of block size", len(ciphertext))
	}
	out := make([]byte, len(ciphertext))
	cipher.NewCBCDecrypter(block, ivBytes[:]).CryptBlocks(out, ciphertext)
	return pkcs7Unpad(out), nil
}

func pkcs7Unpad(in []byte) []byte {
	if len(in) == 0 {
		return in
	}
	pad := int(in[len(in)-1])
	if pad <= 0 || pad > 16 || pad > len(in) {
		return in
	}
	for i := len(in) - pad; i < len(in); i++ {
		if int(in[i]) != pad {
			return in
		}
	}
	return in[:len(in)-pad]
}

var (
	hlsKeyMethodRe = regexp.MustCompile(`METHOD=([A-Z0-9_-]+)`)
	hlsKeyURIRe    = regexp.MustCompile(`URI="([^"]+)"`)
	hlsKeyIVRe     = regexp.MustCompile(`IV=0x([0-9a-fA-F]+)`)
	hlsBandwidthRe = regexp.MustCompile(`BANDWIDTH=(\d+)`)
	hlsMapURIRe    = regexp.MustCompile(`URI="([^"]+)"`)
)

// mapURI extracts the URI attribute from an #EXT-X-MAP tag.
func mapURI(line string) string {
	if m := hlsMapURIRe.FindStringSubmatch(line); len(m) == 2 {
		return strings.TrimSpace(m[1])
	}
	return ""
}

func parseKeyAttrs(line string) (hlsKeyRef, error) {
	var k hlsKeyRef
	if m := hlsKeyMethodRe.FindStringSubmatch(line); len(m) == 2 {
		k.method = strings.TrimSpace(m[1])
	} else {
		return k, errors.New("hls key missing METHOD")
	}
	if strings.EqualFold(k.method, "NONE") {
		return k, nil
	}
	if m := hlsKeyURIRe.FindStringSubmatch(line); len(m) == 2 {
		k.uri = strings.TrimSpace(m[1])
	}
	if k.uri == "" {
		return k, errors.New("hls aes-128 key missing URI")
	}
	if m := hlsKeyIVRe.FindStringSubmatch(line); len(m) == 2 {
		hexStr := m[1]
		if len(hexStr) == 32 {
			b, err := hex.DecodeString(hexStr)
			if err != nil {
				return k, fmt.Errorf("hls key iv decode: %w", err)
			}
			k.iv = b
		}
	}
	return k, nil
}

func bandwidthFromAttrs(line string) int64 {
	if m := hlsBandwidthRe.FindStringSubmatch(line); len(m) == 2 {
		n, _ := strconv.ParseInt(m[1], 10, 64)
		return n
	}
	return 0
}

var (
	urlRe        = regexp.MustCompile(`https?://[^\s"'<>()]+`)
	hlsURIAttrRe = regexp.MustCompile(`URI="([^"]+)"`)
)

// mediaDownloadPolicy is the SSRF policy applied to outbound TIDAL media
// fetches (playlists, segments, keys). The zero value is the production
