package handlers

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/githubesson/lumen/internal/httpx"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/mediaembed"
	"github.com/githubesson/lumen/internal/pathsafe"
	"github.com/githubesson/lumen/internal/tidal"
	"github.com/githubesson/lumen/internal/trackref"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// Stream serves the raw audio file with HTTP range support via
// http.ServeContent. Authentication is enforced by the middleware chain
// (session cookie), same as every other /api route.
func (h *Tracks) Stream(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	ref, err := trackref.Parse(chi.URLParam(r, "id"))
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	download := r.URL.Query().Has("download")
	if ref.Source == trackref.SourceTIDAL {
		if download {
			h.streamTIDALDownload(w, r, ref.ID)
		} else {
			h.streamTIDAL(w, r, ref.ID)
		}
		return
	}
	id := ref.LocalID
	if id == uuid.Nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	// A bare UUID (or local:<uuid>) may actually point at a materialized
	// remote track row — e.g. a TIDAL track added to a playlist gets a
	// tracks row with source='tidal' and file_path='tidal:<id>'. The local
	// file path below would fail (and possibly 403), so infer the source
	// from the DB row and reroute to the TIDAL path using the row's
	// external_id. Playback uses the rewritten HLS playlist; ?download=1
	// assembles a single file instead.
	t, err := h.Library.GetTrack(r.Context(), id, u.ID)
	if err != nil {
		if errors.Is(err, library.ErrNotFound) {
			h.log().Warn("stream: track not found or not visible to this user",
				"track", id, "user", u.ID)
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		h.log().Error("stream: track lookup failed", "track", id, "user", u.ID, "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if strings.EqualFold(t.Source, trackref.SourceTIDAL) && t.ExternalID != "" {
		h.log().Debug("stream: bare uuid resolved to tidal row; rerouting",
			"track", id, "user", u.ID, "tidal_track", t.ExternalID, "download", download)
		if download {
			h.streamTIDALDownload(w, r, t.ExternalID)
		} else {
			h.streamTIDAL(w, r, t.ExternalID)
		}
		return
	}
	roots := h.Ingest.AllRoots(r.Context())
	if !pathWithinAnyRoot(roots, t.FilePath) {
		// The file_path in the DB sits outside every configured music root.
		// Almost always a stale path: the track was ingested under an old
		// MUSIC_PATH (or a now-removed root) that no longer matches.
		h.log().Warn("stream: track file path is outside every configured music root — stale file_path, likely predates a MUSIC_PATH/root change",
			"track", id, "user", u.ID, "path", t.FilePath, "roots", roots)
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	f, err := os.Open(t.FilePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			h.log().Warn("stream: track file is missing on disk",
				"track", id, "user", u.ID, "path", t.FilePath)
			http.Error(w, "file missing on disk", http.StatusGone)
			return
		}
		h.log().Error("stream: could not open track file — check filesystem permissions on the music volume",
			"track", id, "user", u.ID, "path", t.FilePath, "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		h.log().Error("stream: could not stat track file",
			"track", id, "user", u.ID, "path", t.FilePath, "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", audioContentType(t.Format, t.FilePath))
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", "private, max-age=0")
	http.ServeContent(w, r, filepath.Base(t.FilePath), stat.ModTime(), f)
}

func (h *Tracks) streamTIDAL(w http.ResponseWriter, r *http.Request, tidalID string) {
	if h.TIDAL == nil {
		h.log().Warn("stream: tidal client not configured", "tidal_track", tidalID)
		http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
		return
	}
	resp, err := h.TIDAL.HLSResponse(r.Context(), tidalID, r, func(rawURL string) string {
		return tidalHLSProxyURL(tidalID, rawURL)
	})
	if err != nil {
		if errors.Is(err, tidal.ErrNotConfigured) {
			h.log().Warn("stream: tidal proxy not configured", "tidal_track", tidalID, "err", err)
			http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
			return
		}
		if errors.Is(err, tidal.ErrDASHManifest) {
			h.log().Warn("stream: tidal dash manifest unsupported", "tidal_track", tidalID, "err", err)
			http.Error(w, "tidal stream format is not supported yet", http.StatusBadGateway)
			return
		}
		if errors.Is(err, tidal.ErrPreviewManifest) {
			h.log().Warn("stream: tidal preview manifest rejected", "tidal_track", tidalID, "err", err)
			http.Error(w, tidalStreamErrorMessage(err), http.StatusBadGateway)
			return
		}
		h.log().Warn("stream: tidal proxy failed", "tidal_track", tidalID, "err", err)
		http.Error(w, tidalStreamErrorMessage(err), http.StatusBadGateway)
		return
	}
	h.log().Info("stream: tidal track started playing",
		"tidal_track", tidalID,
		"status", resp.StatusCode,
		"content_type", resp.Header.Get("Content-Type"))
	writeTIDALProxyResponse(w, resp)
}

// streamTIDALDownload assembles a single, contiguous audio file for download
// by descending into the HLS playlist, fetching every segment, decrypting
// AES-128-CBC segments per #EXT-X-KEY, and concatenating the decrypted bytes
// into one streamed body. Triggered by ?download=1 on the /stream endpoint so
// live playback (which needs the rewritten HLS playlist) is unaffected.
//
// When ffmpeg is available, the assembled file is remuxed with embedded
// metadata (title, artist, album, year, track no, ISRC) and cover art
// fetched from TIDAL's CDN, producing a fully tagged MP4/FLAC with Range
// support. Without ffmpeg, the raw assembled stream is served as-is.
func (h *Tracks) streamTIDALDownload(w http.ResponseWriter, r *http.Request, tidalID string) {
	if h.TIDAL == nil {
		h.log().Warn("download: tidal client not configured", "tidal_track", tidalID)
		http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
		return
	}
	resp, err := h.TIDAL.FileResponse(r.Context(), tidalID, r)
	if err != nil {
		if errors.Is(err, tidal.ErrNotConfigured) {
			h.log().Warn("download: tidal proxy not configured", "tidal_track", tidalID, "err", err)
			http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
			return
		}
		if errors.Is(err, tidal.ErrDASHManifest) {
			h.log().Warn("download: tidal dash manifest unsupported", "tidal_track", tidalID, "err", err)
			http.Error(w, "tidal stream format is not supported yet", http.StatusBadGateway)
			return
		}
		if errors.Is(err, tidal.ErrPreviewManifest) {
			h.log().Warn("download: tidal preview manifest rejected", "tidal_track", tidalID, "err", err)
			http.Error(w, tidalStreamErrorMessage(err), http.StatusBadGateway)
			return
		}
		h.log().Warn("download: tidal file assembly failed", "tidal_track", tidalID, "err", err)
		http.Error(w, tidalStreamErrorMessage(err), http.StatusBadGateway)
		return
	}

	// Try to embed metadata + cover art via ffmpeg. If anything fails, fall
	// back to the raw assembled file — the download still works, just without
	// tags. This is best-effort: a missing cover or a failed ffmpeg run should
	// never block the download.
	if mediaembed.Available() {
		if tagged, ok := h.embedTIDALMetadata(r.Context(), resp, tidalID); ok {
			defer tagged.Cleanup()
			ct := "audio/mp4"
			if tagged.Format == mediaembed.FormatFLAC {
				ct = "audio/flac"
			}
			w.Header().Set("Content-Type", ct)
			w.Header().Set("Accept-Ranges", "bytes")
			w.Header().Set("Content-Length", strconv.FormatInt(tagged.Size, 10))
			w.Header().Set("Cache-Control", "private, max-age=0")
			h.log().Info("download: tidal track served with embedded metadata",
				"tidal_track", tidalID,
				"size", tagged.Size,
				"format", tagged.Format)
			http.ServeContent(w, r, "track"+tagged.Ext, time.Time{}, tagged.File)
			return
		}
		// embedTIDALMetadata already closed resp.Body on failure; the
		// raw fallback path below needs a fresh FileResponse.
		resp, err = h.TIDAL.FileResponse(r.Context(), tidalID, r)
		if err != nil {
			h.log().Warn("download: tidal raw fallback failed", "tidal_track", tidalID, "err", err)
			http.Error(w, tidalStreamErrorMessage(err), http.StatusBadGateway)
			return
		}
	}

	h.log().Info("download: tidal track file assembled (raw, no metadata)",
		"tidal_track", tidalID,
		"status", resp.StatusCode,
		"content_type", resp.Header.Get("Content-Type"))
	writeTIDALProxyResponse(w, resp)
}

// embedTIDALMetadata fetches track metadata + cover art from TIDAL, then
// pipes the raw assembled audio through ffmpeg to produce a tagged file.
// Returns (result, true) on success. On any failure, closes resp.Body and
// returns (nil, false) so the caller can fall back to a raw download.
func (h *Tracks) embedTIDALMetadata(ctx context.Context, raw *http.Response, tidalID string) (*mediaembed.Result, bool) {
	track, err := h.TIDAL.Track(ctx, tidalID)
	if err != nil {
		h.log().Warn("download: tidal metadata fetch failed; serving raw", "tidal_track", tidalID, "err", err)
		raw.Body.Close()
		return nil, false
	}

	var coverBytes []byte
	if track.CoverURL != "" {
		coverBytes, err = fetchTIDALCoverBytes(ctx, track.CoverURL)
		if err != nil {
			h.log().Warn("download: tidal cover fetch failed; embedding without cover",
				"tidal_track", tidalID, "cover_url", track.CoverURL, "err", err)
		}
	}

	hint := mediaembed.HintFromContentType(raw.Header.Get("Content-Type"))
	meta := mediaembed.Metadata{
		Title:       track.Title,
		Artist:      strings.Join(track.Artists, "; "),
		Album:       track.AlbumTitle,
		AlbumArtist: track.AlbumArtist,
		Year:        track.Year,
		TrackNo:     track.TrackNo,
		DiscNo:      track.DiscNo,
		ISRC:        track.ISRC,
	}

	result, err := mediaembed.Embed(ctx, raw.Body, coverBytes, meta, hint)
	if err != nil {
		h.log().Warn("download: ffmpeg metadata embed failed; serving raw",
			"tidal_track", tidalID, "err", err)
		return nil, false
	}
	return result, true
}

// fetchTIDALCoverBytes downloads cover art from the TIDAL CDN
// (resources.tidal.com). Returns raw image bytes (JPEG/PNG) or an error.
func fetchTIDALCoverBytes(ctx context.Context, coverURL string) ([]byte, error) {
	u, err := allowedRemoteCoverURL(coverURL)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", httpx.BrowserUserAgent)
	req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
	resp, err := remoteCoverHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("cover fetch status %s", resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, maxRemoteCoverBytes))
}

func (h *Tracks) TIDALHLS(w http.ResponseWriter, r *http.Request) {
	ref, err := trackref.Parse(chi.URLParam(r, "id"))
	if err != nil || ref.Source != trackref.SourceTIDAL {
		h.log().Warn("stream: tidal hls bad id", "raw_id", chi.URLParam(r, "id"), "err", err)
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	h.log().Debug("stream: tidal hls request start",
		"tidal_track", ref.ID,
		"path", r.URL.Path,
		"range", r.Header.Get("Range"),
		"user_agent", r.UserAgent())
	if h.TIDAL == nil {
		h.log().Warn("stream: tidal hls client not configured", "tidal_track", ref.ID)
		http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
		return
	}
	rawURL, err := decodeTIDALHLSURL(r.URL.Query().Get("u"))
	if err != nil {
		h.log().Warn("stream: tidal hls bad proxied url", "tidal_track", ref.ID, "err", err)
		http.Error(w, "bad hls url", http.StatusBadRequest)
		return
	}
	resp, err := h.TIDAL.HLSProxyResponse(r.Context(), rawURL, r, func(nextURL string) string {
		return tidalHLSProxyURL(ref.ID, nextURL)
	})
	if err != nil {
		h.log().Warn("stream: tidal hls proxy failed", "tidal_track", ref.ID, "err", err)
		http.Error(w, tidalStreamErrorMessage(err), http.StatusBadGateway)
		return
	}
	h.log().Debug("stream: tidal hls response ready",
		"tidal_track", ref.ID,
		"status", resp.StatusCode,
		"content_type", resp.Header.Get("Content-Type"),
		"content_length", resp.ContentLength)
	writeTIDALProxyResponse(w, resp)
}

func writeTIDALProxyResponse(w http.ResponseWriter, resp *http.Response) {
	defer resp.Body.Close()
	for _, name := range []string{
		"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges",
		"ETag", "Last-Modified",
	} {
		if v := resp.Header.Get(name); v != "" {
			w.Header().Set(name, v)
		}
	}
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "audio/mp4")
	}
	w.Header().Set("Cache-Control", "private, max-age=0")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func tidalHLSProxyURL(tidalID, rawURL string) string {
	q := url.Values{}
	q.Set("u", base64.RawURLEncoding.EncodeToString([]byte(rawURL)))
	return "/api/tracks/" + url.PathEscape(trackref.SourceTIDAL+":"+tidalID) + "/hls?" + q.Encode()
}

func decodeTIDALHLSURL(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", errors.New("missing hls url")
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func tidalStreamErrorMessage(err error) string {
	msg := strings.TrimSpace(err.Error())
	if msg == "" {
		return "tidal stream unavailable"
	}
	return "tidal stream unavailable: " + redactTIDALStreamError(msg)
}

func redactTIDALStreamError(msg string) string {
	msg = streamURLRe.ReplaceAllString(msg, "[url]")
	msg = streamTokenRe.ReplaceAllString(msg, "${1}[redacted]")
	return msg
}

var (
	streamURLRe   = regexp.MustCompile(`https?://[^\s"']+`)
	streamTokenRe = regexp.MustCompile(`(?i)(token=)[^&\s"']+`)
)

// pathWithinAnyRoot returns true when p lives inside any of the configured
// roots. Prevents a stale DB row with a path outside every root from being
// served.
func pathWithinAnyRoot(roots []string, p string) bool {
	return pathsafe.WithinAnyRoot(roots, p)
}

func audioContentType(format, path string) string {
	switch strings.ToLower(format) {
	case "mp3":
		return "audio/mpeg"
	case "flac":
		return "audio/flac"
	case "m4a", "mp4", "aac":
		return "audio/mp4"
	case "webm":
		return "audio/webm"
	case "mov":
		return "video/quicktime"
	case "ogg":
		return "audio/ogg"
	case "opus":
		return "audio/ogg; codecs=opus"
	case "wav":
		return "audio/wav"
	}
	return contentTypeForExt(filepath.Ext(path))
}

func contentTypeForExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".mp3":
		return "audio/mpeg"
	case ".flac":
		return "audio/flac"
	case ".m4a", ".mp4", ".aac":
		return "audio/mp4"
	case ".webm":
		return "audio/webm"
	case ".mov":
		return "video/quicktime"
	case ".ogg":
		return "audio/ogg"
	case ".opus":
		return "audio/ogg; codecs=opus"
	case ".wav":
		return "audio/wav"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	}
	return "application/octet-stream"
}
