package handlers

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/githubesson/lumen/internal/downloadfile"
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
// (session cookie), same as every other /api route. With ?download, the
// file is tagged with the track's metadata first (serveTaggedLocal, and
// streamTIDALDownload for TIDAL tracks).
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
	t, err := h.Library.GetTrackPlayback(r.Context(), id, u.ID)
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
	// A linked track plays its group's best file, falling back to the next
	// best when that one can't be read: a file deleted from disk keeps its
	// row until the next rescan prunes it.
	var f *os.File
	status := 0
	for _, c := range append([]library.PlaybackFile{{FilePath: t.FilePath, Format: t.Format}}, t.Others...) {
		if !pathsafe.WithinAnyRoot(roots, c.FilePath) {
			// The file_path in the DB sits outside every configured music root.
			// Almost always a stale path: the track was ingested under an old
			// MUSIC_PATH (or a now-removed root) that no longer matches.
			h.log().Warn("stream: track file path is outside every configured music root — stale file_path, likely predates a MUSIC_PATH/root change",
				"track", id, "user", u.ID, "path", c.FilePath, "roots", roots)
			status = max(status, http.StatusForbidden)
			continue
		}
		opened, err := os.Open(c.FilePath)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				h.log().Warn("stream: track file is missing on disk",
					"track", id, "user", u.ID, "path", c.FilePath)
				status = max(status, http.StatusGone)
				continue
			}
			h.log().Error("stream: could not open track file — check filesystem permissions on the music volume",
				"track", id, "user", u.ID, "path", c.FilePath, "err", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		f, t.FilePath, t.Format = opened, c.FilePath, c.Format
		break
	}
	switch {
	case f != nil:
	case status == http.StatusGone:
		http.Error(w, "file missing on disk", http.StatusGone)
		return
	default:
		http.Error(w, "forbidden", http.StatusForbidden)
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
	// A download gets the library's metadata written in, as TIDAL downloads
	// get TIDAL's; playback and HEAD probes get the file as stored.
	if download && r.Method != http.MethodHead && h.serveTaggedLocal(w, r, id, u.ID, t.FilePath) {
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
		http.Error(w, tidalStreamErrorMessage(tidal.ErrNotConfigured), http.StatusServiceUnavailable)
		return
	}
	resp, err := h.TIDAL.HLSResponse(r.Context(), tidalID, r, func(rawURL string) string {
		return tidalHLSProxyURL(tidalID, rawURL)
	})
	if err != nil {
		h.writeTIDALStreamError(w, "stream", tidalID, err)
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
// support. Tagging is best-effort: without ffmpeg or the track's metadata
// the assembled stream is served as is, and a failed remux serves the
// assembled file untagged rather than fetching the track again.
func (h *Tracks) streamTIDALDownload(w http.ResponseWriter, r *http.Request, tidalID string) {
	if h.TIDAL == nil {
		h.log().Warn("download: tidal client not configured", "tidal_track", tidalID)
		http.Error(w, tidalStreamErrorMessage(tidal.ErrNotConfigured), http.StatusServiceUnavailable)
		return
	}
	ctx := r.Context()
	var meta mediaembed.Metadata
	var cover []byte
	tag := mediaembed.Available()
	if tag {
		meta, cover, tag = h.tidalDownloadTags(ctx, tidalID)
	}
	resp, err := h.TIDAL.FileResponse(ctx, tidalID, r)
	if err != nil {
		h.writeTIDALStreamError(w, "download", tidalID, err)
		return
	}
	if !tag {
		h.serveTIDALRaw(w, tidalID, resp)
		return
	}
	h.spoolTaggedTIDAL(w, r, tidalID, resp, meta, cover)
}

// spoolTaggedTIDAL spools the assembled TIDAL file in resp, which it closes,
// and serves it through serveTaggedTIDAL: ffmpeg needs the whole file on
// disk, which also keeps it for serving untagged if the remux fails.
func (h *Tracks) spoolTaggedTIDAL(w http.ResponseWriter, r *http.Request, tidalID string, resp *http.Response, meta mediaembed.Metadata, cover []byte) {
	ctx := r.Context()
	contentType := resp.Header.Get("Content-Type")
	hint := mediaembed.HintFromContentType(contentType)
	body := &readErr{r: resp.Body}
	spool, err := mediaembed.Spool(body, hint)
	resp.Body.Close()
	if err != nil {
		switch {
		case ctx.Err() != nil:
			// The client left.
		case body.err != nil:
			h.writeTIDALStreamError(w, "download", tidalID, body.err)
		case errors.Is(err, downloadfile.ErrTooLarge):
			// TIDAL sent more than any track is. Streaming it again would
			// only skip the cap.
			h.log().Warn("download: tidal track exceeds the download size limit", "tidal_track", tidalID, "limit", downloadfile.MaxFileBytes)
			http.Error(w, "track too large", http.StatusBadGateway)
		default:
			// Writing the temp file failed, not TIDAL: the track can still
			// stream through untagged.
			h.log().Warn("download: spooling the tidal track failed; serving raw", "tidal_track", tidalID, "err", err)
			if resp, err = h.TIDAL.FileResponse(ctx, tidalID, r); err != nil {
				h.writeTIDALStreamError(w, "download: raw fallback", tidalID, err)
				return
			}
			h.serveTIDALRaw(w, tidalID, resp)
		}
		return
	}
	defer os.Remove(spool)
	h.serveTaggedTIDAL(w, r, tidalID, spool, contentType, meta, cover)
}

// serveTaggedTIDAL serves the assembled TIDAL file at spool remuxed with
// meta and cover, or as is when the remux fails. contentType is the
// assembled stream's.
func (h *Tracks) serveTaggedTIDAL(w http.ResponseWriter, r *http.Request, tidalID, spool, contentType string, meta mediaembed.Metadata, cover []byte) {
	ctx := r.Context()
	select {
	case tagSlots <- struct{}{}:
		defer func() { <-tagSlots }()
	case <-ctx.Done():
		return // the client left
	}
	hint := mediaembed.HintFromContentType(contentType)
	tagged, err := mediaembed.EmbedFile(ctx, spool, cover, meta, hint)
	if err == nil {
		defer tagged.Cleanup()
		h.log().Info("download: tidal track served with embedded metadata",
			"tidal_track", tidalID,
			"size", tagged.Size,
			"format", tagged.Format)
		serveDownloadFile(w, r, tagged.File, mediaembed.ContentType(tagged.Format), "track"+tagged.Ext)
		return
	}
	if ctx.Err() != nil {
		return
	}
	h.log().Warn("download: ffmpeg metadata embed failed; serving the file untagged",
		"tidal_track", tidalID, "err", err)
	f, err := os.Open(spool)
	if err != nil {
		h.log().Error("download: reopening the assembled tidal file failed", "tidal_track", tidalID, "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	w.Header().Set("X-Content-Type-Options", "nosniff")
	serveDownloadFile(w, r, f, tidalProxyContentType(contentType), "track")
}

// serveTIDALRaw passes the assembled stream through without tags.
func (h *Tracks) serveTIDALRaw(w http.ResponseWriter, tidalID string, resp *http.Response) {
	h.log().Info("download: tidal track file assembled (raw, no metadata)",
		"tidal_track", tidalID,
		"status", resp.StatusCode,
		"content_type", resp.Header.Get("Content-Type"))
	writeTIDALProxyResponse(w, resp)
}

// tidalDownloadTags fetches what a TIDAL download is tagged with: the
// track's metadata and its cover art. ok is false when the metadata can't be
// fetched; a cover that can't be is only left out.
func (h *Tracks) tidalDownloadTags(ctx context.Context, tidalID string) (meta mediaembed.Metadata, cover []byte, ok bool) {
	track, err := h.TIDAL.Track(ctx, tidalID)
	if err != nil {
		h.log().Warn("download: tidal metadata fetch failed; serving raw", "tidal_track", tidalID, "err", err)
		return mediaembed.Metadata{}, nil, false
	}
	if track.CoverURL != "" {
		if cover, err = h.TIDAL.CoverBytes(ctx, track.CoverURL); err != nil {
			h.log().Warn("download: tidal cover fetch failed; embedding without cover",
				"tidal_track", tidalID, "cover_url", track.CoverURL, "err", err)
		}
	}
	return mediaembed.Metadata{
		Title:       track.Title,
		Artist:      strings.Join(track.Artists, "; "),
		Album:       track.AlbumTitle,
		AlbumArtist: track.AlbumArtist,
		Year:        track.Year,
		TrackNo:     track.TrackNo,
		DiscNo:      track.DiscNo,
		ISRC:        track.ISRC,
	}, cover, true
}

// readErr remembers the error reading r failed with, which tells a failed
// TIDAL assembly from a failure writing it to disk.
type readErr struct {
	r   io.Reader
	err error
}

func (e *readErr) Read(p []byte) (int, error) {
	n, err := e.r.Read(p)
	if err != nil && err != io.EOF {
		e.err = err
	}
	return n, err
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
	if resp.StatusCode == http.StatusForbidden {
		// The player can't recover with these URLs; make sure reloading the
		// track gets fresh ones.
		h.log().Info("stream: tidal media host refused a playlist url; dropping the cached stream", "tidal_track", ref.ID)
		h.TIDAL.ForgetStreamURL(ref.ID)
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
		"Content-Length", "Content-Range", "Accept-Ranges",
		"ETag", "Last-Modified",
	} {
		if v := resp.Header.Get(name); v != "" {
			w.Header().Set(name, v)
		}
	}
	// The body is served from our own origin, so never echo an upstream type
	// a browser would render (HTML, SVG, ...).
	w.Header().Set("Content-Type", tidalProxyContentType(resp.Header.Get("Content-Type")))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=0")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// tidalProxyContentType passes through media and HLS playlist types and maps
// everything else to a non-renderable type. An empty upstream type keeps the
// historical audio/mp4 default.
func tidalProxyContentType(upstream string) string {
	if strings.TrimSpace(upstream) == "" {
		return "audio/mp4"
	}
	mt, _, err := mime.ParseMediaType(upstream)
	if err != nil {
		return "application/octet-stream"
	}
	switch {
	case strings.HasPrefix(mt, "audio/"),
		mt == "video/mp4", mt == "video/mp2t",
		mt == "application/vnd.apple.mpegurl", mt == "application/x-mpegurl":
		return upstream
	}
	return "application/octet-stream"
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

// writeTIDALStreamError answers a failed TIDAL stream or download. op
// prefixes the log message.
func (h *Tracks) writeTIDALStreamError(w http.ResponseWriter, op, tidalID string, err error) {
	status := http.StatusBadGateway
	switch {
	case errors.Is(err, tidal.ErrNotConfigured):
		status = http.StatusServiceUnavailable
		h.log().Warn(op+": tidal proxy not configured", "tidal_track", tidalID, "err", err)
	case errors.Is(err, tidal.ErrDASHManifest):
		h.log().Warn(op+": tidal dash manifest unsupported", "tidal_track", tidalID, "err", err)
	case errors.Is(err, tidal.ErrPreviewManifest):
		h.log().Warn(op+": tidal preview manifest rejected", "tidal_track", tidalID, "err", err)
	case errors.Is(err, tidal.ErrRefused):
		h.log().Warn(op+": tidal refused the track", "tidal_track", tidalID, "err", err)
	default:
		h.log().Warn(op+": tidal proxy failed", "tidal_track", tidalID, "err", err)
	}
	http.Error(w, tidalStreamErrorMessage(err), status)
}

// tidalStreamErrorMessage is the client-facing text for a failed TIDAL
// stream; the players show it to the user as is. Upstream errors carry dial
// targets (internal IPs and ports), hifi API bodies and account details, so
// they only go to the log — every caller logs err before responding.
func tidalStreamErrorMessage(err error) string {
	switch {
	case errors.Is(err, tidal.ErrNotConfigured):
		return "TIDAL isn't set up on this server."
	case errors.Is(err, tidal.ErrDASHManifest):
		return "TIDAL sent a stream format Lumen can't play yet."
	case errors.Is(err, tidal.ErrPreviewManifest):
		return "TIDAL only has a preview of this track."
	case errors.Is(err, tidal.ErrRefused):
		return tidalRefusalText("TIDAL refused to stream this track", err)
	}
	return "Couldn't stream this track from TIDAL. Try again later."
}

// tidalRefusalText is lead, plus TIDAL's reason for refusing when it gave
// one. That reason is TIDAL's own user-facing text, unlike the rest of an
// upstream error. Leads start with "TIDAL refused": clients tell a refusal
// from other 502s by it (core's tidalRefusalMessage).
func tidalRefusalText(lead string, err error) string {
	var refused *tidal.RefusedError
	if errors.As(err, &refused) {
		return refusalText(lead, refused.Reason)
	}
	return refusalText(lead, "")
}

// refusalText is lead, plus reason when there is one.
func refusalText(lead, reason string) string {
	if reason != "" {
		return lead + ": " + reason
	}
	return lead + "."
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
