package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	_ "golang.org/x/image/webp"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/preview"
	"github.com/githubesson/lumen/internal/storage"
	"github.com/githubesson/lumen/internal/tidal"
	"github.com/githubesson/lumen/internal/trackref"
)

// Share wires the endpoints that let a user copy a Lumen track link into
// Discord and get a Spotify/Apple-Music-style inline video preview. Three
// endpoints are involved:
//
//   - POST /api/tracks/{id}/share?t=N     — authenticated: mints a signed share URL
//   - GET  /share/track/{id}?t=N&sig=X    — public: HTML page with OG tags (what Discord scrapes)
//   - GET  /api/public/previews/{id}.mp4  — public: the 30s MP4 referenced by og:video
//
// The signature on the share URL proves an authenticated user generated it,
// which bounds how many distinct (track, start_sec) previews the ffmpeg
// builder can be asked to produce. The signature on the MP4 URL is shorter-
// lived and rotates hourly so Discord's CDN keeps the cached video across
// a listening session without the URL ever leaking past ~2 hours.
type Share struct {
	Library      *library.Store
	Storage      storage.Storage
	Ingest       *ingest.Service
	Preview      *preview.Builder
	TIDAL        *tidal.Client
	ShareSignKey []byte
}

// isTIDALTrack reports whether the row is a materialized TIDAL track: audio
// lives behind the TIDAL proxy (file_path is a virtual "tidal:<id>" ref), not
// on the local filesystem.
func isTIDALTrack(t *library.TrackDetail) bool {
	return strings.EqualFold(t.Source, trackref.SourceTIDAL) && t.ExternalID != ""
}

type shareLinkResp struct {
	URL       string `json:"url"`
	StartSec  int    `json:"start_sec"`
	ExpiresAt int64  `json:"expires_at,omitempty"` // 0 = never
}

type publicShareResp struct {
	TrackID            string `json:"track_id"`
	Title              string `json:"title"`
	Artist             string `json:"artist,omitempty"`
	Album              string `json:"album,omitempty"`
	AlbumID            string `json:"album_id,omitempty"`
	StartSec           int    `json:"start_sec"`
	DurationMS         int    `json:"duration_ms"`
	PreviewDurationSec int    `json:"preview_duration_sec"`
	PreviewURL         string `json:"preview_url"`
	StoryURL           string `json:"story_url,omitempty"`
	StoryBackgroundURL string `json:"story_background_url,omitempty"`
	EmbedURL           string `json:"embed_url,omitempty"`
	CoverURL           string `json:"cover_url,omitempty"`
	AccentColor        string `json:"accent_color,omitempty"`
	CanonicalURL       string `json:"canonical_url"`
	OpenURL            string `json:"open_url"`
}

const maxStoryBackgroundUploadBytes int64 = 24 << 20

// Create mints a signed share URL for (track, start_sec). The URL is long-
// lived — users paste it in chat and it needs to keep working. Requires
// auth because it indirectly permits preview-MP4 generation.
func (h *Share) Create(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	if len(h.ShareSignKey) == 0 {
		http.Error(w, "signing not configured", http.StatusServiceUnavailable)
		return
	}
	ref, err := trackref.Parse(chi.URLParam(r, "id"))
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	var id uuid.UUID
	switch ref.Source {
	case trackref.SourceLocal:
		id = ref.LocalID
	case trackref.SourceTIDAL:
		// Browse-only TIDAL tracks have no row yet. Materialize the hidden
		// row (same mechanism playlist-add uses) so the signed public
		// endpoints get the stable UUID they are keyed on — share links are
		// long-lived, so the row must outlive this request.
		id, err = materializeTIDALTrack(r.Context(), h.Library, h.TIDAL, ref.ID)
		if err != nil {
			if errors.Is(err, tidal.ErrNotConfigured) {
				http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
				return
			}
			slog.Warn("share create: tidal track materialize failed",
				"tidal_track", ref.ID, "user", u.ID, "err", err)
			http.Error(w, "tidal track lookup failed", http.StatusBadGateway)
			return
		}
	default:
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	startSec, err := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("t")))
	if err != nil || startSec < 0 {
		http.Error(w, "bad t", http.StatusBadRequest)
		return
	}
	// Verify the user can actually see this track — no point minting a
	// share URL that will 404 for the scraper (and leaks track existence
	// to unauthorized users besides).
	t, err := h.Library.GetTrack(r.Context(), id, u.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	// Clamp start so the 30s window stays within the track.
	maxStart := 0
	if dur := t.DurationMS / 1000; dur > int(preview.PreviewDuration/time.Second) {
		maxStart = dur - int(preview.PreviewDuration/time.Second)
	}
	if startSec > maxStart {
		startSec = maxStart
	}

	sig := auth.SignShareURL(h.ShareSignKey, id.String(), startSec)
	base := resolveBaseURL(r)
	url := base + "/share/track/" + id.String() + "?t=" + strconv.Itoa(startSec) + "&sig=" + sig

	// Pre-warm the MP4 so the first Discord scrape doesn't have to wait on
	// ffmpeg. Fire-and-forget with a detached context — the request context
	// would be cancelled the moment we return, killing ffmpeg mid-run.
	switch {
	case h.Preview == nil:
		slog.Warn("preview prewarm skipped: builder not configured",
			"track_id", id.String())
	case !isTIDALTrack(t) && !pathWithinAnyRoot(h.Ingest.AllRoots(r.Context()), t.FilePath):
		slog.Warn("preview prewarm skipped: file outside configured roots",
			"track_id", id.String(), "file_path", t.FilePath)
	default:
		go h.prewarmPreview(t, preview.Input{
			TrackID:  id.String(),
			StartSec: startSec,
			Title:    t.Title,
			Artist:   primaryArtistName(t),
		})
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "private, no-store")
	_ = json.NewEncoder(w).Encode(shareLinkResp{URL: url, StartSec: startSec})
}

// prewarmPreview materializes the audio (TIDAL tracks are assembled to a
// temp file) and cover, then triggers a preview build off-request. Uses a
// detached context with a generous deadline — the request goroutine is gone
// by the time ffmpeg finishes, so binding to r.Context() would kill the
// build as soon as we respond.
func (h *Share) prewarmPreview(t *library.TrackDetail, in preview.Input) {
	// Panics in a fire-and-forget goroutine would silently die without
	// Chi's Recoverer (it only wraps request handlers). Catch any panic
	// here so the next share attempt doesn't hit a dead builder.
	defer func() {
		if p := recover(); p != nil {
			slog.Error("preview prewarm panicked",
				"track_id", in.TrackID, "panic", fmt.Sprint(p))
		}
	}()

	// TIDAL tracks download the full file before ffmpeg can slice it, which
	// can take well over the minute a local build needs.
	timeout := 60 * time.Second
	if isTIDALTrack(t) {
		timeout = 4 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	slog.Info("preview prewarm starting",
		"track_id", in.TrackID,
		"start_sec", in.StartSec,
		"source", t.Source,
		"cover_key", t.CoverArtPath)

	audioPath, cleanupAudio, err := h.audioPathForBuild(ctx, t)
	if err != nil {
		slog.Error("preview prewarm: audio materialize failed",
			"track_id", in.TrackID, "source", t.Source, "err", err)
		return
	}
	defer cleanupAudio()
	in.AudioPath = audioPath

	if coverPath, cleanupCover, cerr := h.coverToTemp(ctx, t); cerr == nil {
		in.CoverPath = coverPath
		defer cleanupCover()
	} else if t.CoverArtPath != "" || t.CoverURL != "" {
		slog.Warn("preview prewarm: cover materialize failed",
			"track_id", in.TrackID, "cover_key", t.CoverArtPath, "err", cerr)
	}
	out, err := h.Preview.EnsureBuilt(ctx, in)
	if err != nil {
		slog.Error("preview prewarm failed",
			"track_id", in.TrackID,
			"start_sec", in.StartSec,
			"err", err)
		return
	}
	slog.Info("preview prewarm built", "track_id", in.TrackID, "path", out)

	storyOut, err := h.Preview.EnsureStoryBackgroundBuilt(ctx, in)
	if err != nil {
		slog.Error("story background prewarm failed",
			"track_id", in.TrackID,
			"start_sec", in.StartSec,
			"err", err)
		return
	}
	slog.Info("story background prewarm built", "track_id", in.TrackID, "path", storyOut)
}

// Page renders the HTML scraped by Discord / chat apps when the share URL
// unfurls. Real humans get a tiny landing page + meta refresh to the app.
//
// Deliberately public — the signature on the URL *is* the auth. An attacker
// who guesses a (track_id, start_sec) pair without a valid sig gets nothing.
func (h *Share) Page(w http.ResponseWriter, r *http.Request) {
	if len(h.ShareSignKey) == 0 {
		http.Error(w, "signing not configured", http.StatusServiceUnavailable)
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	q := r.URL.Query()
	startSec, err := strconv.Atoi(q.Get("t"))
	if err != nil || startSec < 0 {
		http.Error(w, "bad t", http.StatusBadRequest)
		return
	}
	sig := q.Get("sig")
	if err := auth.VerifyShareURL(h.ShareSignKey, id.String(), startSec, sig); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	t, err := h.Library.GetTrackPublic(r.Context(), id)
	if err != nil {
		// Public preview: only global (non-owner) tracks can be shared. A
		// personally-owned track's share URL will 404 to everyone but the
		// owner, which is fine — they'll just pick a track that's in the
		// library for everyone.
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	base := resolveBaseURL(r)
	// FxEmbed-style direct video: scrapers see a stable, video-looking URL on
	// our domain, and that URL serves the generated MP4 directly.
	videoURL := sharePreviewVideoURL(base, id, startSec, sig)

	// Cover URL — reuse the existing cover-sign logic. If the track has no
	// album/cover, omit og:image; Discord falls back to the first frame of
	// the video anyway.
	var coverURL string
	var accentColor string
	now := time.Now()
	if t.AlbumID != nil {
		cExp, cSig := auth.SignCoverURL(h.ShareSignKey, "album", t.AlbumID.String(), now)
		coverURL = base + "/api/public/covers/album/" + t.AlbumID.String() +
			"?exp=" + auth.FormatExp(cExp) + "&sig=" + cSig
		accentColor = h.accentColorForTrack(r.Context(), t)
	}

	title := t.Title
	if title == "" {
		title = "Untitled track"
	}
	artist := primaryArtistName(t)
	description := artist
	if t.AlbumTitle != "" {
		if description != "" {
			description += " · " + t.AlbumTitle
		} else {
			description = t.AlbumTitle
		}
	}

	canonical := base + r.URL.Path + "?t=" + strconv.Itoa(startSec) + "&sig=" + sig
	// Human-readable landing URL. Chat scrapers read this backend page for
	// OG tags, while browsers land on the React preview UI.
	// The canonical share URL remains the copied chat URL.
	// Clicking through opens the preview player.
	landing := shareFrontendURL(base, id, startSec, sig)

	html := renderSharePage(shareMeta{
		Title:       title,
		Description: description,
		Artist:      artist,
		Album:       t.AlbumTitle,
		Canonical:   canonical,
		CoverURL:    coverURL,
		VideoURL:    videoURL,
		ThemeColor:  accentColor,
		Landing:     landing,
	})

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// Short cache — Discord's scraper respects this, and we want updates
	// to metadata to show up quickly when the track gets re-shared.
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = io.WriteString(w, html)
}

// PublicInfo returns the same signed public media URLs used in the OG tags,
// plus display metadata for the browser-facing React share preview. It is
// cookie-less: the long-lived share signature is the authorization.
func (h *Share) PublicInfo(w http.ResponseWriter, r *http.Request) {
	if len(h.ShareSignKey) == 0 {
		http.Error(w, "signing not configured", http.StatusServiceUnavailable)
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	q := r.URL.Query()
	startSec, err := strconv.Atoi(q.Get("t"))
	if err != nil || startSec < 0 {
		http.Error(w, "bad t", http.StatusBadRequest)
		return
	}
	sig := q.Get("sig")
	if err := auth.VerifyShareURL(h.ShareSignKey, id.String(), startSec, sig); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	t, err := h.Library.GetTrackPublic(r.Context(), id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	base := resolveBaseURL(r)
	now := time.Now()
	mp4Exp, mp4Sig := auth.SignPreviewURL(h.ShareSignKey, id.String(), startSec, now)
	previewURL := base + "/api/public/previews/" + id.String() + ".mp4" +
		"?t=" + strconv.Itoa(startSec) +
		"&exp=" + auth.FormatExp(mp4Exp) +
		"&sig=" + mp4Sig
	storyURL := base + "/api/public/stories/" + id.String() + ".mp4" +
		"?t=" + strconv.Itoa(startSec) +
		"&exp=" + auth.FormatExp(mp4Exp) +
		"&sig=" + mp4Sig
	storyBackgroundURL := base + "/api/public/story-backgrounds/" + id.String() + ".mp4" +
		"?t=" + strconv.Itoa(startSec) +
		"&exp=" + auth.FormatExp(mp4Exp) +
		"&sig=" + mp4Sig

	var coverURL string
	var accentColor string
	var albumID string
	if t.AlbumID != nil {
		albumID = t.AlbumID.String()
		cExp, cSig := auth.SignCoverURL(h.ShareSignKey, "album", albumID, now)
		coverURL = base + "/api/public/covers/album/" + albumID +
			"?exp=" + auth.FormatExp(cExp) + "&sig=" + cSig
		accentColor = h.accentColorForTrack(r.Context(), t)
	}

	title := t.Title
	if title == "" {
		title = "Untitled track"
	}
	canonical := base + "/share/track/" + id.String() + "?t=" + strconv.Itoa(startSec) + "&sig=" + sig
	embedURL := shareEmbedURL(base, id, startSec, sig)
	resp := publicShareResp{
		TrackID:            id.String(),
		Title:              title,
		Artist:             primaryArtistName(t),
		Album:              t.AlbumTitle,
		AlbumID:            albumID,
		StartSec:           startSec,
		DurationMS:         t.DurationMS,
		PreviewDurationSec: int(preview.PreviewDuration / time.Second),
		PreviewURL:         previewURL,
		StoryURL:           storyURL,
		StoryBackgroundURL: storyBackgroundURL,
		EmbedURL:           embedURL,
		CoverURL:           coverURL,
		AccentColor:        accentColor,
		CanonicalURL:       canonical,
		OpenURL:            base + "/library",
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_ = json.NewEncoder(w).Encode(resp)
}

// PublicPreviewVideo serves a stable share-signed preview MP4 URL. It keeps the
// FxEmbed-like same-origin .mp4 URL that scrapers prefer, but avoids a redirect
// hop so Telegram receives the actual media response from the advertised URL.
// signedMediaRequest is the parsed+verified form of a public signed media URL
// (/api/public/previews|preview-videos|stories|story-backgrounds/{id}.mp4).
type signedMediaRequest struct {
	id       uuid.UUID
	startSec int
	exp      int64 // 0 when the route uses the no-expiry share signature
}

// parseSignedMediaRequest implements the shared front half of every public
// signed-media handler: the not-configured guard, the ".mp4"-suffixed id, the
// t parameter, and signature verification. withExpiry selects between the
// hourly-rotating preview signature (exp+sig) and the long-lived share
// signature (sig only). Returns ok=false once a response has been written.
func (h *Share) parseSignedMediaRequest(w http.ResponseWriter, r *http.Request, withExpiry bool) (signedMediaRequest, bool) {
	var req signedMediaRequest
	if len(h.ShareSignKey) == 0 || h.Preview == nil {
		http.Error(w, "preview not configured", http.StatusServiceUnavailable)
		return req, false
	}
	raw := strings.TrimSuffix(chi.URLParam(r, "id"), ".mp4")
	id, err := uuid.Parse(raw)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return req, false
	}
	req.id = id
	q := r.URL.Query()
	req.startSec, err = strconv.Atoi(q.Get("t"))
	if err != nil || req.startSec < 0 {
		http.Error(w, "bad t", http.StatusBadRequest)
		return req, false
	}
	sig := q.Get("sig")
	if withExpiry {
		req.exp, err = strconv.ParseInt(q.Get("exp"), 10, 64)
		if err != nil {
			http.Error(w, "bad exp", http.StatusBadRequest)
			return req, false
		}
		if err := auth.VerifyPreviewURL(h.ShareSignKey, id.String(), req.startSec, sig, req.exp, time.Now()); err != nil {
			http.Error(w, "forbidden", http.StatusForbidden)
			return req, false
		}
		return req, true
	}
	if err := auth.VerifyShareURL(h.ShareSignKey, id.String(), req.startSec, sig); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return req, false
	}
	return req, true
}

// loadPublicTrack loads the track behind a verified signed-media request and
// applies the same path-traversal guard the /stream handler uses. logLabel
// names the endpoint in warn logs (e.g. "story serve"). TIDAL rows skip the
// root guard: their file_path is a virtual "tidal:<id>" ref, not a
// filesystem path.
func (h *Share) loadPublicTrack(w http.ResponseWriter, r *http.Request, id uuid.UUID, logLabel string) (*library.TrackDetail, bool) {
	t, err := h.Library.GetTrackPublic(r.Context(), id)
	if err != nil {
		slog.Warn(logLabel+": track lookup failed",
			"track_id", id.String(), "err", err)
		http.Error(w, "not found", http.StatusNotFound)
		return nil, false
	}
	if !isTIDALTrack(t) && !pathWithinAnyRoot(h.Ingest.AllRoots(r.Context()), t.FilePath) {
		slog.Warn(logLabel+": file path outside configured roots",
			"track_id", id.String(), "file_path", t.FilePath)
		http.Error(w, "forbidden", http.StatusForbidden)
		return nil, false
	}
	return t, true
}

// audioPathForBuild resolves a local audio path for a preview build. Local
// tracks point straight at their file on disk; TIDAL tracks are assembled
// (segment fetch + decrypt + concat) to a temp file first. That assembly is
// the expensive path — callers should check the preview cache before asking
// for it. The returned cleanup is always safe to call.
func (h *Share) audioPathForBuild(ctx context.Context, t *library.TrackDetail) (string, func(), error) {
	noop := func() {}
	if !isTIDALTrack(t) {
		return t.FilePath, noop, nil
	}
	if h.TIDAL == nil {
		return "", noop, tidal.ErrNotConfigured
	}
	resp, err := h.TIDAL.FileResponse(ctx, t.ExternalID, nil)
	if err != nil {
		return "", noop, err
	}
	defer resp.Body.Close()
	tmp, err := os.CreateTemp("", "lumen-tidal-audio-*")
	if err != nil {
		return "", noop, err
	}
	cleanup := func() { _ = os.Remove(tmp.Name()) }
	if _, err := io.Copy(tmp, resp.Body); err != nil {
		_ = tmp.Close()
		cleanup()
		return "", noop, err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return "", noop, err
	}
	return tmp.Name(), cleanup, nil
}

// writeAudioResolveError maps an audioPathForBuild failure to a response.
func writeAudioResolveError(w http.ResponseWriter, err error) {
	if errors.Is(err, tidal.ErrNotConfigured) {
		http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
		return
	}
	http.Error(w, "preview generation failed", http.StatusInternalServerError)
}

// coverPathWithFallback materializes the cover for ffmpeg, downgrading to a
// coverless render on failure (non-fatal). failMsg is the endpoint-specific
// warn message. The returned cleanup is always safe to call.
func (h *Share) coverPathWithFallback(r *http.Request, t *library.TrackDetail, id uuid.UUID, failMsg string) (string, func()) {
	coverFSPath, cleanupCover, err := h.coverToTemp(r.Context(), t)
	if err != nil {
		if t.CoverArtPath != "" || t.CoverURL != "" {
			slog.Warn(failMsg,
				"track_id", id.String(), "cover_key", t.CoverArtPath, "err", err)
		}
		coverFSPath = ""
	}
	return coverFSPath, cleanupCover
}

// serveMediaFile streams a built MP4 with the shared open/stat error policy.
// missingMsg is the body for an unopenable file ("preview missing" / "story
// missing"); cacheControl is the endpoint's Cache-Control value.
func serveMediaFile(w http.ResponseWriter, r *http.Request, outPath, missingMsg, cacheControl string) {
	f, err := os.Open(outPath)
	if err != nil {
		http.Error(w, missingMsg, http.StatusInternalServerError)
		return
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", cacheControl)
	http.ServeContent(w, r, filepath.Base(outPath), stat.ModTime(), f)
}

// immutableCacheControl caches a signed media response until its signature
// expires (with a 60s floor so a just-expiring URL still caches briefly).
func immutableCacheControl(exp int64) string {
	remaining := max(exp-time.Now().Unix(), 60)
	return "public, max-age=" + strconv.FormatInt(remaining, 10) + ", immutable"
}

func (h *Share) PublicPreviewVideo(w http.ResponseWriter, r *http.Request) {
	req, ok := h.parseSignedMediaRequest(w, r, false)
	if !ok {
		return
	}
	// Already built → serve straight from disk without touching the DB or
	// (for TIDAL tracks) re-downloading the audio.
	if outPath, ok := h.Preview.CachedPreview(req.id.String(), req.startSec); ok {
		serveMediaFile(w, r, outPath, "preview missing", "public, max-age=3600")
		return
	}
	t, ok := h.loadPublicTrack(w, r, req.id, "preview video serve")
	if !ok {
		return
	}
	audioPath, cleanupAudio, err := h.audioPathForBuild(r.Context(), t)
	if err != nil {
		slog.Error("preview video serve: audio materialize failed",
			"track_id", req.id.String(), "source", t.Source, "err", err)
		writeAudioResolveError(w, err)
		return
	}
	defer cleanupAudio()
	coverFSPath, cleanupCover := h.coverPathWithFallback(r, t, req.id,
		"preview video serve: cover materialize failed; falling back to audio-only")
	defer cleanupCover()

	outPath, err := h.Preview.EnsureBuilt(r.Context(), preview.Input{
		TrackID:   req.id.String(),
		AudioPath: audioPath,
		CoverPath: coverFSPath,
		StartSec:  req.startSec,
	})
	if err != nil {
		slog.Error("preview video serve: EnsureBuilt failed",
			"track_id", req.id.String(),
			"start_sec", req.startSec,
			"audio_path", audioPath,
			"cover_path", coverFSPath,
			"err", err)
		http.Error(w, "preview generation failed", http.StatusInternalServerError)
		return
	}
	serveMediaFile(w, r, outPath, "preview missing", "public, max-age=3600")
}

// Embed renders a small public player for clients that explicitly request the
// embed_url returned by PublicInfo. Scraper metadata stays pointed at the
// direct generated MP4 flow instead.
func (h *Share) Embed(w http.ResponseWriter, r *http.Request) {
	if len(h.ShareSignKey) == 0 {
		http.Error(w, "signing not configured", http.StatusServiceUnavailable)
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	q := r.URL.Query()
	startSec, err := strconv.Atoi(q.Get("t"))
	if err != nil || startSec < 0 {
		http.Error(w, "bad t", http.StatusBadRequest)
		return
	}
	sig := q.Get("sig")
	if err := auth.VerifyShareURL(h.ShareSignKey, id.String(), startSec, sig); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	t, err := h.Library.GetTrackPublic(r.Context(), id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	base := resolveBaseURL(r)
	now := time.Now()
	mp4Exp, mp4Sig := auth.SignPreviewURL(h.ShareSignKey, id.String(), startSec, now)
	videoURL := base + "/api/public/previews/" + id.String() + ".mp4" +
		"?t=" + strconv.Itoa(startSec) +
		"&exp=" + auth.FormatExp(mp4Exp) +
		"&sig=" + mp4Sig

	var coverURL string
	var accentColor string
	if t.AlbumID != nil {
		cExp, cSig := auth.SignCoverURL(h.ShareSignKey, "album", t.AlbumID.String(), now)
		coverURL = base + "/api/public/covers/album/" + t.AlbumID.String() +
			"?exp=" + auth.FormatExp(cExp) + "&sig=" + cSig
		accentColor = h.accentColorForTrack(r.Context(), t)
	}

	title := t.Title
	if title == "" {
		title = "Untitled track"
	}
	artist := primaryArtistName(t)
	description := artist
	if t.AlbumTitle != "" {
		if description != "" {
			description += " - " + t.AlbumTitle
		} else {
			description = t.AlbumTitle
		}
	}
	canonical := base + "/share/track/" + id.String() + "?t=" + strconv.Itoa(startSec) + "&sig=" + sig
	landing := shareFrontendURL(base, id, startSec, sig)

	html := renderShareEmbedPage(shareMeta{
		Title:       title,
		Description: description,
		Artist:      artist,
		Album:       t.AlbumTitle,
		Canonical:   canonical,
		CoverURL:    coverURL,
		VideoURL:    videoURL,
		ThemeColor:  accentColor,
		Landing:     landing,
	})

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = io.WriteString(w, html)
}

// PublicPreview serves the 30s MP4. First-hit generates it via ffmpeg (a
// handful of seconds); subsequent hits stream straight from disk. Discord's
// media proxy also caches aggressively, so the ffmpeg path only runs once
// per (track, start_sec) per cache-rotation window.
func (h *Share) PublicPreview(w http.ResponseWriter, r *http.Request) {
	req, ok := h.parseSignedMediaRequest(w, r, true)
	if !ok {
		return
	}
	if outPath, ok := h.Preview.CachedPreview(req.id.String(), req.startSec); ok {
		serveMediaFile(w, r, outPath, "preview missing", immutableCacheControl(req.exp))
		return
	}
	t, ok := h.loadPublicTrack(w, r, req.id, "preview serve")
	if !ok {
		return
	}
	audioPath, cleanupAudio, err := h.audioPathForBuild(r.Context(), t)
	if err != nil {
		slog.Error("preview serve: audio materialize failed",
			"track_id", req.id.String(), "source", t.Source, "err", err)
		writeAudioResolveError(w, err)
		return
	}
	defer cleanupAudio()
	// Non-fatal — builder will emit an audio-only (black frame) MP4.
	coverFSPath, cleanupCover := h.coverPathWithFallback(r, t, req.id,
		"preview serve: cover materialize failed; falling back to audio-only")
	defer cleanupCover()

	outPath, err := h.Preview.EnsureBuilt(r.Context(), preview.Input{
		TrackID:   req.id.String(),
		AudioPath: audioPath,
		CoverPath: coverFSPath,
		StartSec:  req.startSec,
	})
	if err != nil {
		slog.Error("preview serve: EnsureBuilt failed",
			"track_id", req.id.String(),
			"start_sec", req.startSec,
			"audio_path", audioPath,
			"cover_path", coverFSPath,
			"err", err)
		http.Error(w, "preview generation failed", http.StatusInternalServerError)
		return
	}
	serveMediaFile(w, r, outPath, "preview missing", immutableCacheControl(req.exp))
}

// PublicStory serves a 9:16 MP4 intended for Instagram Stories. It uses the
// same signed URL scheme as the Discord preview endpoint, but renders the
// artwork card, metadata, and textured color background server-side so the
// mobile app only has to download and hand the video to Instagram.
func (h *Share) PublicStory(w http.ResponseWriter, r *http.Request) {
	h.servePublicStory(w, r, false)
}

// PublicStoryBackground serves only the animated/static color background for
// Instagram Stories. Mobile clients layer a native sticker image on top, which
// keeps text crisper than baking it into the MP4.
func (h *Share) PublicStoryBackground(w http.ResponseWriter, r *http.Request) {
	h.servePublicStory(w, r, true)
}

// CustomStoryBackground renders a one-off Instagram Story background video
// using an authenticated user's uploaded image plus normalized crop values.
// The generated MP4 is streamed directly and removed after the response.
func (h *Share) CustomStoryBackground(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	if h.Preview == nil {
		http.Error(w, "preview not configured", http.StatusServiceUnavailable)
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxStoryBackgroundUploadBytes)
	if err := r.ParseMultipartForm(maxStoryBackgroundUploadBytes); err != nil {
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

	startSec, err := formInt(r, "start_sec")
	if err != nil {
		startSec, err = formInt(r, "t")
	}
	if err != nil || startSec < 0 {
		http.Error(w, "bad start_sec", http.StatusBadRequest)
		return
	}

	t, err := h.Library.GetTrack(r.Context(), id, u.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	maxStart := 0
	if dur := t.DurationMS / 1000; dur > int(preview.PreviewDuration/time.Second) {
		maxStart = dur - int(preview.PreviewDuration/time.Second)
	}
	if startSec > maxStart {
		startSec = maxStart
	}
	if !isTIDALTrack(t) && !pathWithinAnyRoot(h.Ingest.AllRoots(r.Context()), t.FilePath) {
		slog.Warn("custom story background: file path outside configured roots",
			"track_id", id.String(), "user", u.ID, "file_path", t.FilePath)
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	audioPath, cleanupAudio, err := h.audioPathForBuild(r.Context(), t)
	if err != nil {
		slog.Error("custom story background: audio materialize failed",
			"track_id", id.String(), "user", u.ID, "source", t.Source, "err", err)
		writeAudioResolveError(w, err)
		return
	}
	defer cleanupAudio()

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "no image file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	ext := filepath.Ext(header.Filename)
	if ext == "" {
		ext = ".jpg"
	}
	tmp, err := os.CreateTemp("", "lumen-story-bg-*"+ext)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	bgPath := tmp.Name()
	defer os.Remove(bgPath)
	if _, err := io.Copy(tmp, file); err != nil {
		_ = tmp.Close()
		http.Error(w, "could not read upload", http.StatusBadRequest)
		return
	}
	if err := tmp.Close(); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	outPath := filepath.Join(
		h.Preview.CacheDir,
		id.String()+"-"+strconv.Itoa(startSec)+"-"+uuid.NewString()+"-custom-story-bg.mp4",
	)
	defer os.Remove(outPath)
	defer os.Remove(outPath + ".part")

	err = h.Preview.BuildCustomStoryBackground(r.Context(), preview.Input{
		TrackID:   id.String(),
		AudioPath: audioPath,
		StartSec:  startSec,
	}, preview.CustomBackground{
		ImagePath: bgPath,
		Crop: preview.Crop{
			X:      formFloatDefault(r, "crop_x", 0),
			Y:      formFloatDefault(r, "crop_y", 0),
			Width:  formFloatDefault(r, "crop_width", 1),
			Height: formFloatDefault(r, "crop_height", 1),
		},
	}, outPath)
	if err != nil {
		slog.Error("custom story background: render failed",
			"track_id", id.String(),
			"user", u.ID,
			"start_sec", startSec,
			"err", err)
		http.Error(w, "story generation failed", http.StatusInternalServerError)
		return
	}

	serveMediaFile(w, r, outPath, "story missing", "private, no-store")
}

func (h *Share) servePublicStory(w http.ResponseWriter, r *http.Request, backgroundOnly bool) {
	req, ok := h.parseSignedMediaRequest(w, r, true)
	if !ok {
		return
	}
	cached := h.Preview.CachedStory
	if backgroundOnly {
		cached = h.Preview.CachedStoryBackground
	}
	if outPath, ok := cached(req.id.String(), req.startSec); ok {
		serveMediaFile(w, r, outPath, "story missing", immutableCacheControl(req.exp))
		return
	}
	t, ok := h.loadPublicTrack(w, r, req.id, "story serve")
	if !ok {
		return
	}
	audioPath, cleanupAudio, err := h.audioPathForBuild(r.Context(), t)
	if err != nil {
		slog.Error("story serve: audio materialize failed",
			"track_id", req.id.String(), "source", t.Source, "err", err)
		writeAudioResolveError(w, err)
		return
	}
	defer cleanupAudio()
	coverFSPath, cleanupCover := h.coverPathWithFallback(r, t, req.id,
		"story serve: cover materialize failed; falling back to no-cover card")
	defer cleanupCover()

	title := t.Title
	if title == "" {
		title = "Untitled track"
	}
	input := preview.Input{
		TrackID:   req.id.String(),
		AudioPath: audioPath,
		CoverPath: coverFSPath,
		StartSec:  req.startSec,
		Title:     title,
		Artist:    primaryArtistName(t),
	}
	var outPath string
	if backgroundOnly {
		outPath, err = h.Preview.EnsureStoryBackgroundBuilt(r.Context(), input)
	} else {
		outPath, err = h.Preview.EnsureStoryBuilt(r.Context(), input)
	}
	if err != nil {
		slog.Error("story serve: EnsureStoryBuilt failed",
			"track_id", req.id.String(),
			"start_sec", req.startSec,
			"background_only", backgroundOnly,
			"audio_path", audioPath,
			"cover_path", coverFSPath,
			"err", err)
		http.Error(w, "story generation failed", http.StatusInternalServerError)
		return
	}
	serveMediaFile(w, r, outPath, "story missing", immutableCacheControl(req.exp))
}

// coverToTemp materializes the cover art to a readable local path so ffmpeg
// can mux it as the static video frame. Local covers come from storage;
// materialized streamed tracks (no storage key) fall back to their remote
// CDN artwork via the in-RAM cover cache.
//
// Returns (path, cleanup, err). cleanup is always safe to call even on
// error or when no temp file was created.
func (h *Share) coverToTemp(ctx context.Context, t *library.TrackDetail) (string, func(), error) {
	noop := func() {}
	if t.CoverArtPath == "" {
		if t.CoverURL != "" {
			return remoteCoverToTemp(t.CoverURL)
		}
		return "", noop, errors.New("no cover")
	}
	body, _, err := h.Storage.Get(ctx, t.CoverArtPath)
	if err != nil {
		return "", noop, err
	}
	defer body.Close()

	tmp, err := os.CreateTemp("", "lumen-cover-*"+filepath.Ext(t.CoverArtPath))
	if err != nil {
		return "", noop, err
	}
	cleanup := func() { _ = os.Remove(tmp.Name()) }
	if _, err := io.Copy(tmp, body); err != nil {
		_ = tmp.Close()
		cleanup()
		return "", noop, err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return "", noop, err
	}
	return tmp.Name(), cleanup, nil
}

// remoteCoverToTemp fetches an allowed remote cover (TIDAL CDN artwork) into
// a temp file. Goes through the shared in-RAM cover cache, so repeated
// builds for the same album don't re-hit the CDN.
func remoteCoverToTemp(rawURL string) (string, func(), error) {
	noop := func() {}
	u, err := allowedRemoteCoverURL(rawURL)
	if err != nil {
		return "", noop, err
	}
	data, _, err := coverCache.fetchCached(u)
	if err != nil {
		return "", noop, err
	}
	tmp, err := os.CreateTemp("", "lumen-cover-*"+filepath.Ext(u.Path))
	if err != nil {
		return "", noop, err
	}
	cleanup := func() { _ = os.Remove(tmp.Name()) }
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return "", noop, err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return "", noop, err
	}
	return tmp.Name(), cleanup, nil
}
func formInt(r *http.Request, name string) (int, error) {
	raw := strings.TrimSpace(r.FormValue(name))
	if raw == "" {
		return 0, errors.New("missing int field")
	}
	return strconv.Atoi(raw)
}

func formFloatDefault(r *http.Request, name string, fallback float64) float64 {
	raw := strings.TrimSpace(r.FormValue(name))
	if raw == "" {
		return fallback
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return fallback
	}
	return v
}
