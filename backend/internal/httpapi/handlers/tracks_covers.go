package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"net/url"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // register webp decoding for uploaded/resized covers

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/httpx"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/tidal"
	"github.com/githubesson/lumen/internal/trackref"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

const maxServedCoverDimension = 1024

// maxCoverUploadBytes caps an admin's cover-art upload. Cover art is small;
// 16 MiB is comfortably above any real album scan while still bounding memory.
const maxCoverUploadBytes int64 = 16 << 20

const maxRemoteCoverBytes int64 = 16 << 20

var remoteCoverHTTPClient = &http.Client{
	Timeout: 10 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		_, err := allowedRemoteCoverURL(req.URL.String())
		return err
	},
}

// TrackCover serves the cover art associated with a single track's album.
func (h *Tracks) TrackCover(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	id, err := resolveTrackRowID(r.Context(), h.Library, h.TIDAL, chi.URLParam(r, "id"), false)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	t, err := h.Library.GetTrack(r.Context(), id, u.ID)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	maxSize := parseCoverMaxSize(r)
	if t.CoverArtPath != "" {
		h.serveStorageObject(w, r, t.CoverArtPath, maxSize)
		return
	}
	if t.CoverURL != "" {
		h.serveRemoteCover(w, r, t.CoverURL)
		return
	}
	http.Error(w, "no cover", http.StatusNotFound)
}

// AlbumCover serves the cover for an album directly.
func (h *Tracks) AlbumCover(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	maxSize := parseCoverMaxSize(r)
	if key, err := h.Library.AlbumCoverPathForViewer(r.Context(), id, u.ID); err == nil {
		h.serveStorageObject(w, r, key, maxSize)
		return
	} else if !errors.Is(err, library.ErrNotFound) {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	cover, err := h.Library.RemoteAlbumCoverForViewer(r.Context(), id, u.ID)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	h.serveRemoteCover(w, r, remoteCoverURLForSize(cover, maxSize))
}

// PutAlbumCover replaces an album's cover art with an uploaded image. Admin
// only. Accepts a multipart form with a single `file` part; the image is
// normalized (decoded, resized, re-encoded as JPEG) and stored content-
// addressed, then the album row is pointed at the new key. Returns the updated
// album so the client can refresh without a second request.
func (h *Tracks) PutAlbumCover(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxCoverUploadBytes)
	if err := r.ParseMultipartForm(maxCoverUploadBytes); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			http.Error(w, "image too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "no image file", http.StatusBadRequest)
		return
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, "could not read upload", http.StatusBadRequest)
		return
	}
	// Decode once up front to reject anything that isn't a real, supported
	// image before it ever reaches storage.
	if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
		http.Error(w, "file is not a supported image (jpeg, png, webp)", http.StatusBadRequest)
		return
	}
	key, err := h.Ingest.StoreCoverImage(r.Context(), data, header.Header.Get("Content-Type"))
	if err != nil || key == "" {
		h.log().Error("album cover: storing the uploaded image failed",
			"album", id, "user", u.ID, "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if err := h.Library.SetAlbumCover(r.Context(), id, key); err != nil {
		if errors.Is(err, library.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		h.log().Error("album cover: pointing the album at the new key failed",
			"album", id, "user", u.ID, "key", key, "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	h.log().Info("album cover replaced", "album", id, "user", u.ID, "key", key)
	a, err := h.Library.GetAlbum(r.Context(), id, u.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, makeAlbumResp(a))
}

// DeleteAlbumCover clears an album's cover art, reverting it to the
// hash-tinted placeholder. Admin only. The content-addressed blob is left in
// storage since other albums may reference it. Returns the updated album.
func (h *Tracks) DeleteAlbumCover(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	if err := h.Library.ClearAlbumCover(r.Context(), id); err != nil {
		if errors.Is(err, library.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		h.log().Error("album cover: clearing the cover reference failed",
			"album", id, "user", u.ID, "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	h.log().Info("album cover removed", "album", id, "user", u.ID)
	a, err := h.Library.GetAlbum(r.Context(), id, u.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, makeAlbumResp(a))
}

type signCoverResp struct {
	URL       string `json:"url"`
	ExpiresAt int64  `json:"expires_at"`
}

// SignCover issues a short-lived signed URL that serves an album cover
// without session auth. The renderer calls this before pushing Discord
// Rich Presence so Discord's media proxy (cookie-less) can fetch artwork.
func (h *Tracks) SignCover(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	if len(h.CoverSignKey) == 0 {
		http.Error(w, "signing not configured", http.StatusServiceUnavailable)
		return
	}
	raw := strings.TrimSpace(r.URL.Query().Get("album_id"))
	if raw == "" {
		http.Error(w, "album_id required", http.StatusBadRequest)
		return
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		http.Error(w, "bad album_id", http.StatusBadRequest)
		return
	}
	// Refuse to mint URLs for albums with no cover, so clients don't ship
	// a URL that will resolve to 404 on Discord (which then caches the
	// failure).
	if _, err := h.Library.AlbumCoverPathForViewer(r.Context(), id, u.ID); err != nil {
		http.Error(w, "no cover", http.StatusNotFound)
		return
	}
	exp, sig := auth.SignCoverURL(h.CoverSignKey, "album", id.String(), time.Now())
	resp := signCoverResp{
		URL:       "/api/public/covers/album/" + id.String() + "?exp=" + auth.FormatExp(exp) + "&sig=" + sig,
		ExpiresAt: exp,
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	// Same-hour sign calls return identical URLs; let intermediaries cache
	// briefly so the renderer's per-track calls stay cheap.
	w.Header().Set("Cache-Control", "private, max-age=60")
	_ = json.NewEncoder(w).Encode(resp)
}

// PublicAlbumCover serves an album cover when called with a valid HMAC
// signature. No session auth — the signature *is* the auth token. Served
// with a long public Cache-Control so Discord's CDN can cache the image.
func (h *Tracks) PublicAlbumCover(w http.ResponseWriter, r *http.Request) {
	if len(h.CoverSignKey) == 0 {
		http.Error(w, "signing not configured", http.StatusServiceUnavailable)
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	q := r.URL.Query()
	expRaw := q.Get("exp")
	sig := q.Get("sig")
	exp, err := strconv.ParseInt(expRaw, 10, 64)
	if err != nil {
		http.Error(w, "bad exp", http.StatusBadRequest)
		return
	}
	if err := auth.VerifyCoverURL(h.CoverSignKey, "album", id.String(), sig, exp, time.Now()); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	key, err := h.Library.AlbumCoverPath(r.Context(), id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	h.servePublicStorageObject(w, r, key, exp)
}

// servePublicStorageObject is the cookie-less variant of serveStorageObject.
// It emits a *public* Cache-Control so Discord's media proxy keeps the image
// cached for the lifetime of the signature.
func (h *Tracks) servePublicStorageObject(w http.ResponseWriter, r *http.Request, key string, exp int64) {
	body, info, err := h.Storage.Get(r.Context(), key)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer body.Close()
	ct := info.ContentType
	if ct == "" {
		ct = contentTypeForExt(filepath.Ext(key))
	}
	remaining := max(exp-time.Now().Unix(), 60)
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "public, max-age="+strconv.FormatInt(remaining, 10)+", immutable")
	http.ServeContent(w, r, filepath.Base(key), zeroTime(), body)
}

func (h *Tracks) serveStorageObject(w http.ResponseWriter, r *http.Request, key string, maxSize int) {
	body, info, err := h.Storage.Get(r.Context(), key)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer body.Close()
	ct := info.ContentType
	if ct == "" {
		ct = contentTypeForExt(filepath.Ext(key))
	}
	if maxSize > 0 {
		if ok := h.serveResizedImage(w, r, body, key, maxSize); ok {
			return
		}
		if _, err := body.Seek(0, io.SeekStart); err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	// No modtime from the Storage interface; use zero (disables 304 handling).
	http.ServeContent(w, r, filepath.Base(key), zeroTime(), body)
}

func remoteCoverURLForSize(cover library.RemoteCover, maxSize int) string {
	if cover.CoverURL != "" {
		return cover.CoverURL
	}
	if strings.EqualFold(cover.Source, trackref.SourceTIDAL) && cover.CoverID != "" {
		return tidal.CoverURL(cover.CoverID, tidalCoverSize(maxSize))
	}
	return ""
}

func tidalCoverSize(maxSize int) int {
	switch {
	case maxSize <= 80:
		return 80
	case maxSize <= 640:
		return 640
	default:
		return 1280
	}
}

// RemoteCoverProxy serves an allowed remote cover (TIDAL CDN artwork) from
// the backend. Track payloads point clients here instead of at the CDN so the
// image arrives same-origin: the CDN sends no CORS headers, which would taint
// any canvas the cover is drawn on (ambient accent extraction). The host
// allowlist in allowedRemoteCoverURL keeps this from being an open proxy.
func (h *Tracks) RemoteCoverProxy(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireUser(w, r); !ok {
		return
	}
	h.serveRemoteCover(w, r, r.URL.Query().Get("url"))
}

// proxyRemoteCoverURL swaps an absolute remote cover URL for the same-origin
// proxy path and starts warming the RAM cache so the image is hot by the time
// the client asks for it. Empty, relative, and disallowed-host URLs pass
// through unchanged.
func proxyRemoteCoverURL(raw string) string {
	if raw == "" || !strings.HasPrefix(raw, "http") {
		return raw
	}
	if _, err := allowedRemoteCoverURL(raw); err != nil {
		return raw
	}
	coverCache.warm(raw)
	return "/api/covers/remote?url=" + url.QueryEscape(raw)
}

func (h *Tracks) serveRemoteCover(w http.ResponseWriter, r *http.Request, rawURL string) {
	u, err := allowedRemoteCoverURL(rawURL)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	data, ct, err := coverCache.fetchCached(u)
	if err != nil {
		var statusErr *remoteCoverStatusError
		if errors.As(err, &statusErr) {
			h.log().Warn("remote cover fetch non-2xx", "host", u.Hostname(), "status", statusErr.status)
			http.Redirect(w, r, u.String(), http.StatusFound)
			return
		}
		h.log().Warn("remote cover fetch failed", "host", u.Hostname(), "err", err)
		http.Error(w, "cover fetch failed", http.StatusBadGateway)
		return
	}
	writeRemoteCover(w, data, ct)
}

func writeRemoteCover(w http.ResponseWriter, data []byte, ct string) {
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	// Public artwork; explicit CORS keeps canvas pixel reads clean even when
	// a client loads the app from a different origin than the API.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	_, _ = w.Write(data)
}

// remoteCoverStatusError reports a non-2xx upstream response so the serving
// path can fall back to redirecting the client at the CDN directly.
type remoteCoverStatusError struct{ status int }

func (e *remoteCoverStatusError) Error() string {
	return "remote cover fetch returned status " + strconv.Itoa(e.status)
}

func fetchRemoteCover(ctx context.Context, u *url.URL) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", httpx.BrowserUserAgent)
	req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Referer", "https://tidal.com/")
	req.Header.Set("Sec-Fetch-Dest", "image")
	req.Header.Set("Sec-Fetch-Mode", "no-cors")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	resp, err := remoteCoverHTTPClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", &remoteCoverStatusError{status: resp.StatusCode}
	}
	if resp.ContentLength > maxRemoteCoverBytes {
		return nil, "", errors.New("remote cover exceeds size limit")
	}
	ct := strings.TrimSpace(resp.Header.Get("Content-Type"))
	if ct == "" {
		ct = contentTypeForExt(filepath.Ext(u.Path))
	}
	if !strings.HasPrefix(strings.ToLower(ct), "image/") {
		return nil, "", errors.New("remote cover fetch returned non-image content type " + ct)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxRemoteCoverBytes+1))
	if err != nil {
		return nil, "", err
	}
	if int64(len(data)) > maxRemoteCoverBytes {
		return nil, "", errors.New("remote cover exceeds size limit")
	}
	return data, ct, nil
}

func allowedRemoteCoverURL(rawURL string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return nil, err
	}
	if u.Scheme != "https" {
		return nil, errors.New("remote cover URL must be HTTPS")
	}
	if strings.ToLower(u.Hostname()) != "resources.tidal.com" {
		return nil, errors.New("remote cover host is not allowed")
	}
	return u, nil
}

func parseCoverMaxSize(r *http.Request) int {
	raw := strings.TrimSpace(r.URL.Query().Get("size"))
	if raw == "" {
		return maxServedCoverDimension
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return maxServedCoverDimension
	}
	if n > maxServedCoverDimension {
		return maxServedCoverDimension
	}
	return n
}

func (h *Tracks) serveResizedImage(
	w http.ResponseWriter,
	r *http.Request,
	body io.ReadSeeker,
	key string,
	maxSize int,
) bool {
	thumbKey, thumbType := thumbnailCacheKey(key, maxSize)
	if cached, _, err := h.Storage.Get(r.Context(), thumbKey); err == nil {
		defer cached.Close()
		w.Header().Set("Content-Type", thumbType)
		w.Header().Set("Cache-Control", "private, max-age=86400")
		http.ServeContent(w, r, path.Base(thumbKey), zeroTime(), cached)
		return true
	}
	src, _, err := image.Decode(body)
	if err != nil {
		return false
	}
	bounds := src.Bounds()
	dstW, dstH, _ := thumbnailDimensions(bounds.Dx(), bounds.Dy(), maxSize)

	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, bounds, xdraw.Over, nil)

	var buf bytes.Buffer
	outType := thumbType
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 82}); err != nil {
		return false
	}

	if _, err := h.Storage.Put(
		r.Context(),
		thumbKey,
		bytes.NewReader(buf.Bytes()),
		int64(buf.Len()),
		outType,
	); err != nil {
		w.Header().Set("Content-Type", outType)
		w.Header().Set("Cache-Control", "private, max-age=86400")
		http.ServeContent(w, r, path.Base(thumbKey), zeroTime(), bytes.NewReader(buf.Bytes()))
		return true
	}

	w.Header().Set("Content-Type", outType)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeContent(w, r, path.Base(thumbKey), zeroTime(), bytes.NewReader(buf.Bytes()))
	return true
}

func thumbnailDimensions(width int, height int, maxSize int) (int, int, bool) {
	if width <= 0 || height <= 0 || maxSize <= 0 {
		return width, height, false
	}
	if width <= maxSize && height <= maxSize {
		return width, height, false
	}
	if width >= height {
		return maxSize, max(1, int(float64(height)*float64(maxSize)/float64(width))), true
	}
	return max(1, int(float64(width)*float64(maxSize)/float64(height))), maxSize, true
}

func thumbnailCacheKey(key string, maxSize int) (string, string) {
	outType := "image/jpeg"
	ext := ".jpg"
	base := strings.TrimPrefix(key, "/")
	base = strings.TrimSuffix(base, path.Ext(base))
	return path.Join("cover-thumbs", strconv.Itoa(maxSize), base+ext), outType
}
