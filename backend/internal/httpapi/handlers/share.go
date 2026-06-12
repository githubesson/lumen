package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/preview"
	"github.com/githubesson/lumen/internal/storage"
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
	ShareSignKey []byte
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
	id, ok := pathUUID(w, r, "id")
	if !ok {
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
	case !pathWithinAnyRoot(h.Ingest.AllRoots(r.Context()), t.FilePath):
		slog.Warn("preview prewarm skipped: file outside configured roots",
			"track_id", id.String(), "file_path", t.FilePath)
	default:
		go prewarmPreview(h.Preview, h.Storage, t.CoverArtPath, preview.Input{
			TrackID:   id.String(),
			AudioPath: t.FilePath,
			StartSec:  startSec,
			Title:     t.Title,
			Artist:    primaryArtistName(t),
		})
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "private, no-store")
	_ = json.NewEncoder(w).Encode(shareLinkResp{URL: url, StartSec: startSec})
}

// prewarmPreview materializes the cover (if any) and triggers a preview
// build off-request. Uses a detached context with a generous deadline —
// the request goroutine is gone by the time ffmpeg finishes, so binding
// to r.Context() would kill the build as soon as we respond.
func prewarmPreview(b *preview.Builder, s storage.Storage, coverKey string, in preview.Input) {
	// Panics in a fire-and-forget goroutine would silently die without
	// Chi's Recoverer (it only wraps request handlers). Catch any panic
	// here so the next share attempt doesn't hit a dead builder.
	defer func() {
		if p := recover(); p != nil {
			slog.Error("preview prewarm panicked",
				"track_id", in.TrackID, "panic", fmt.Sprint(p))
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	slog.Info("preview prewarm starting",
		"track_id", in.TrackID,
		"start_sec", in.StartSec,
		"audio_path", in.AudioPath,
		"cover_key", coverKey)

	if coverKey != "" {
		if body, _, err := s.Get(ctx, coverKey); err == nil {
			tmp, terr := os.CreateTemp("", "lumen-cover-*"+filepath.Ext(coverKey))
			if terr == nil {
				if _, cerr := io.Copy(tmp, body); cerr == nil {
					_ = tmp.Close()
					in.CoverPath = tmp.Name()
					defer os.Remove(tmp.Name())
				} else {
					_ = tmp.Close()
					_ = os.Remove(tmp.Name())
					slog.Warn("preview cover copy failed",
						"track_id", in.TrackID, "err", cerr)
				}
			} else {
				slog.Warn("preview cover temp create failed",
					"track_id", in.TrackID, "err", terr)
			}
			_ = body.Close()
		} else {
			slog.Warn("preview cover fetch failed",
				"track_id", in.TrackID, "cover_key", coverKey, "err", err)
		}
	}
	out, err := b.EnsureBuilt(ctx, in)
	if err != nil {
		slog.Error("preview prewarm failed",
			"track_id", in.TrackID,
			"start_sec", in.StartSec,
			"err", err)
		return
	}
	slog.Info("preview prewarm built", "track_id", in.TrackID, "path", out)

	storyOut, err := b.EnsureStoryBackgroundBuilt(ctx, in)
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
		accentColor = h.accentColorForCover(r.Context(), t.CoverArtPath)
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
		accentColor = h.accentColorForCover(r.Context(), t.CoverArtPath)
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
// names the endpoint in warn logs (e.g. "story serve").
func (h *Share) loadPublicTrack(w http.ResponseWriter, r *http.Request, id uuid.UUID, logLabel string) (*library.TrackDetail, bool) {
	t, err := h.Library.GetTrackPublic(r.Context(), id)
	if err != nil {
		slog.Warn(logLabel+": track lookup failed",
			"track_id", id.String(), "err", err)
		http.Error(w, "not found", http.StatusNotFound)
		return nil, false
	}
	if !pathWithinAnyRoot(h.Ingest.AllRoots(r.Context()), t.FilePath) {
		slog.Warn(logLabel+": file path outside configured roots",
			"track_id", id.String(), "file_path", t.FilePath)
		http.Error(w, "forbidden", http.StatusForbidden)
		return nil, false
	}
	return t, true
}

// coverPathWithFallback materializes the cover for ffmpeg, downgrading to a
// coverless render on failure (non-fatal). failMsg is the endpoint-specific
// warn message. The returned cleanup is always safe to call.
func (h *Share) coverPathWithFallback(r *http.Request, t *library.TrackDetail, id uuid.UUID, failMsg string) (string, func()) {
	coverFSPath, cleanupCover, err := h.localCoverPath(r, t)
	if err != nil {
		if t.CoverArtPath != "" {
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
	t, ok := h.loadPublicTrack(w, r, req.id, "preview video serve")
	if !ok {
		return
	}
	coverFSPath, cleanupCover := h.coverPathWithFallback(r, t, req.id,
		"preview video serve: cover materialize failed; falling back to audio-only")
	defer cleanupCover()

	outPath, err := h.Preview.EnsureBuilt(r.Context(), preview.Input{
		TrackID:   req.id.String(),
		AudioPath: t.FilePath,
		CoverPath: coverFSPath,
		StartSec:  req.startSec,
	})
	if err != nil {
		slog.Error("preview video serve: EnsureBuilt failed",
			"track_id", req.id.String(),
			"start_sec", req.startSec,
			"audio_path", t.FilePath,
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
		accentColor = h.accentColorForCover(r.Context(), t.CoverArtPath)
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
	t, ok := h.loadPublicTrack(w, r, req.id, "preview serve")
	if !ok {
		return
	}
	// Non-fatal — builder will emit an audio-only (black frame) MP4.
	coverFSPath, cleanupCover := h.coverPathWithFallback(r, t, req.id,
		"preview serve: cover materialize failed; falling back to audio-only")
	defer cleanupCover()

	outPath, err := h.Preview.EnsureBuilt(r.Context(), preview.Input{
		TrackID:   req.id.String(),
		AudioPath: t.FilePath,
		CoverPath: coverFSPath,
		StartSec:  req.startSec,
	})
	if err != nil {
		slog.Error("preview serve: EnsureBuilt failed",
			"track_id", req.id.String(),
			"start_sec", req.startSec,
			"audio_path", t.FilePath,
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
	if !pathWithinAnyRoot(h.Ingest.AllRoots(r.Context()), t.FilePath) {
		slog.Warn("custom story background: file path outside configured roots",
			"track_id", id.String(), "user", u.ID, "file_path", t.FilePath)
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

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
		AudioPath: t.FilePath,
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
	t, ok := h.loadPublicTrack(w, r, req.id, "story serve")
	if !ok {
		return
	}
	coverFSPath, cleanupCover := h.coverPathWithFallback(r, t, req.id,
		"story serve: cover materialize failed; falling back to no-cover card")
	defer cleanupCover()

	title := t.Title
	if title == "" {
		title = "Untitled track"
	}
	input := preview.Input{
		TrackID:   req.id.String(),
		AudioPath: t.FilePath,
		CoverPath: coverFSPath,
		StartSec:  req.startSec,
		Title:     title,
		Artist:    primaryArtistName(t),
	}
	var outPath string
	var err error
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
			"audio_path", t.FilePath,
			"cover_path", coverFSPath,
			"err", err)
		http.Error(w, "story generation failed", http.StatusInternalServerError)
		return
	}
	serveMediaFile(w, r, outPath, "story missing", immutableCacheControl(req.exp))
}

// localCoverPath materializes the album cover to a readable local path so
// ffmpeg can mux it as the static video frame. For the Local storage
// backend this is effectively a free indirection (same file on disk); for
// a future S3 backend it copies to a temp file and returns a cleanup.
//
// Returns (path, cleanup, err). cleanup is always safe to call even on
// error or when no temp file was created.
func (h *Share) localCoverPath(r *http.Request, t *library.TrackDetail) (string, func(), error) {
	noop := func() {}
	if t.CoverArtPath == "" {
		return "", noop, errors.New("no cover")
	}
	body, _, err := h.Storage.Get(r.Context(), t.CoverArtPath)
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

// resolveBaseURL derives the public origin from the request itself —
// X-Forwarded-Host + X-Forwarded-Proto when the reverse proxy forwards
// them (Caddy/nginx both do by default in this repo's deploy configs),
// otherwise r.Host + r.TLS. Either way the origin the user typed in the
// browser is what ends up in share links and og:url.
func resolveBaseURL(r *http.Request) string {
	scheme := fallbackScheme(r)
	if p, ok := validForwardedProto(r.Header.Get("X-Forwarded-Proto")); ok {
		scheme = p
	} else if p, ok := validForwardedProto(forwardedHeaderValue(r.Header.Get("Forwarded"), "proto")); ok {
		scheme = p
	}

	host := r.Host
	if fh, ok := validForwardedHost(r.Header.Get("X-Forwarded-Host")); ok {
		host = fh
	} else if fh, ok := validForwardedHost(forwardedHeaderValue(r.Header.Get("Forwarded"), "host")); ok {
		host = fh
	}
	return scheme + "://" + host
}

func fallbackScheme(r *http.Request) string {
	if r.TLS == nil {
		return "http"
	}
	return "https"
}

func validForwardedProto(raw string) (string, bool) {
	p := strings.ToLower(firstForwardedToken(raw))
	if p != "http" && p != "https" {
		return "", false
	}
	return p, true
}

func validForwardedHost(raw string) (string, bool) {
	host := firstForwardedToken(raw)
	if host == "" || strings.ContainsAny(host, " \t\r\n/\\") {
		return "", false
	}
	u, err := url.Parse("http://" + host)
	if err != nil || u.Host == "" || u.Host != host || u.User != nil {
		return "", false
	}
	if u.Hostname() == "" {
		return "", false
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n <= 0 || n > 65535 {
			return "", false
		}
	}
	return host, true
}

func firstForwardedToken(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if i := strings.IndexByte(raw, ','); i >= 0 {
		raw = raw[:i]
	}
	raw = strings.TrimSpace(raw)
	raw = strings.Trim(raw, `"`)
	return strings.TrimSpace(raw)
}

func forwardedHeaderValue(raw string, key string) string {
	first := firstForwardedToken(raw)
	if first == "" {
		return ""
	}
	for _, part := range strings.Split(first, ";") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok || !strings.EqualFold(strings.TrimSpace(k), key) {
			continue
		}
		return strings.Trim(strings.TrimSpace(v), `"`)
	}
	return ""
}

func shareFrontendURL(base string, id uuid.UUID, startSec int, sig string) string {
	q := url.Values{}
	q.Set("t", strconv.Itoa(startSec))
	q.Set("sig", sig)
	return base + "/shared/track/" + id.String() + "?" + q.Encode()
}

func sharePreviewVideoURL(base string, id uuid.UUID, startSec int, sig string) string {
	q := url.Values{}
	q.Set("t", strconv.Itoa(startSec))
	q.Set("sig", sig)
	return base + "/api/public/preview-videos/" + id.String() + ".mp4?" + q.Encode()
}

func shareEmbedURL(base string, id uuid.UUID, startSec int, sig string) string {
	q := url.Values{}
	q.Set("t", strconv.Itoa(startSec))
	q.Set("sig", sig)
	return base + "/embed/track/" + id.String() + "?" + q.Encode()
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

type accentOKLCH struct {
	l float64
	c float64
	h float64
}

func (h *Share) accentColorForCover(ctx context.Context, coverKey string) string {
	if coverKey == "" || h.Storage == nil {
		return ""
	}
	body, _, err := h.Storage.Get(ctx, coverKey)
	if err != nil {
		return ""
	}
	defer body.Close()

	src, _, err := image.Decode(body)
	if err != nil {
		return ""
	}
	raw, ok := extractAccentFromImage(src)
	if !ok {
		return ""
	}
	accent := clampAccentDark(raw)
	return oklchToHex(accent)
}

func extractAccentFromImage(src image.Image) (accentOKLCH, bool) {
	const size = 32
	dst := image.NewRGBA(image.Rect(0, 0, size, size))
	xdraw.ApproxBiLinear.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Src, nil)

	var best accentOKLCH
	var fallback accentOKLCH
	bestScore := math.Inf(-1)
	fallbackScore := math.Inf(-1)
	hasBest := false
	hasFallback := false

	for y := 0; y < size; y++ {
		row := y * dst.Stride
		for x := 0; x < size; x++ {
			i := row + x*4
			a := dst.Pix[i+3]
			if a < 200 {
				continue
			}
			c := rgbToOklch(float64(dst.Pix[i]), float64(dst.Pix[i+1]), float64(dst.Pix[i+2]))
			if c.l < 0.15 || c.l > 0.92 {
				continue
			}
			score := c.c * (1 - math.Abs(c.l-0.55))
			if c.c >= 0.08 && score > bestScore {
				bestScore = score
				best = c
				hasBest = true
			}
			if score > fallbackScore {
				fallbackScore = score
				fallback = c
				hasFallback = true
			}
		}
	}
	if hasBest {
		return best, true
	}
	return fallback, hasFallback
}

func rgbToOklch(r, g, b float64) accentOKLCH {
	lr := srgbToLinear(r)
	lg := srgbToLinear(g)
	lb := srgbToLinear(b)
	l_ := math.Cbrt(0.4122214708*lr + 0.5363325363*lg + 0.0514459929*lb)
	m_ := math.Cbrt(0.2119034982*lr + 0.6806995451*lg + 0.1073969566*lb)
	s_ := math.Cbrt(0.0883024619*lr + 0.2817188376*lg + 0.6299787005*lb)
	L := 0.2104542553*l_ + 0.7936177850*m_ - 0.0040720468*s_
	a := 1.9779984951*l_ - 2.4285922050*m_ + 0.4505937099*s_
	bb := 0.0259040371*l_ + 0.7827717662*m_ - 0.8086757660*s_
	C := math.Hypot(a, bb)
	H := math.Atan2(bb, a) * 180 / math.Pi
	if H < 0 {
		H += 360
	}
	return accentOKLCH{l: L, c: C, h: H}
}

func srgbToLinear(v float64) float64 {
	s := v / 255
	if s <= 0.04045 {
		return s / 12.92
	}
	return math.Pow((s+0.055)/1.055, 2.4)
}

func clampAccentDark(raw accentOKLCH) accentOKLCH {
	const targetL = 0.72
	const targetC = 0.17
	l := math.Max(targetL-0.04, math.Min(targetL+0.04, raw.l))
	c := math.Max(0.08, math.Min(targetC+0.04, raw.c))
	return accentOKLCH{l: l, c: c, h: raw.h}
}

func oklchToHex(c accentOKLCH) string {
	h := c.h * math.Pi / 180
	a := c.c * math.Cos(h)
	b := c.c * math.Sin(h)

	l_ := c.l + 0.3963377774*a + 0.2158037573*b
	m_ := c.l - 0.1055613458*a - 0.0638541728*b
	s_ := c.l - 0.0894841775*a - 1.2914855480*b

	l := l_ * l_ * l_
	m := m_ * m_ * m_
	s := s_ * s_ * s_

	r := linearToSRGB(4.0767416621*l - 3.3077115913*m + 0.2309699292*s)
	g := linearToSRGB(-1.2684380046*l + 2.6097574011*m - 0.3413193965*s)
	bl := linearToSRGB(-0.0041960863*l - 0.7034186147*m + 1.7076147010*s)

	return fmt.Sprintf("#%02x%02x%02x", byte(math.Round(r*255)), byte(math.Round(g*255)), byte(math.Round(bl*255)))
}

func linearToSRGB(v float64) float64 {
	v = math.Max(0, math.Min(1, v))
	if v <= 0.0031308 {
		return 12.92 * v
	}
	return 1.055*math.Pow(v, 1/2.4) - 0.055
}

func primaryArtistName(t *library.TrackDetail) string {
	// Prefer the artist marked "primary"; fall back to the first artist
	// regardless of role, so composer-only tracks still have *something*
	// in the Discord card instead of a blank subtitle.
	for _, a := range t.Artists {
		if a.Role == "primary" {
			return a.Name
		}
	}
	if len(t.Artists) > 0 {
		return t.Artists[0].Name
	}
	return ""
}

type shareMeta struct {
	Title       string
	Description string
	Artist      string
	Album       string
	Canonical   string
	CoverURL    string
	VideoURL    string
	ThemeColor  string
	Landing     string
}

// renderSharePage writes the scraper-facing HTML. Minimal on purpose: the
// only audience that matters for styling is Discord / Twitter / Slack
// crawlers, and they only read the <meta> tags in <head>. Humans get a
// meta-refresh to the app (with a plain anchor as a fallback).
func renderSharePage(m shareMeta) string {
	var b strings.Builder
	b.Grow(2048)
	b.WriteString("<!doctype html>\n<html lang=\"en\">\n<head>\n")
	b.WriteString(`<meta charset="utf-8">`)
	b.WriteString(`<meta name="viewport" content="width=device-width,initial-scale=1">`)
	writeTitleTag(&b, m.Title, m.Artist)
	writeMetaName(&b, "description", m.Description)
	writeMetaName(&b, "theme-color", m.ThemeColor)

	// Open Graph — the primary surface.
	writeMetaProp(&b, "og:site_name", "Lumen")
	writeMetaProp(&b, "og:type", "video.other")
	writeMetaProp(&b, "og:title", m.Title)
	writeMetaProp(&b, "og:description", m.Description)
	writeMetaProp(&b, "og:url", m.Canonical)
	if m.CoverURL != "" {
		writeMetaProp(&b, "og:image", m.CoverURL)
		writeMetaProp(&b, "og:image:secure_url", m.CoverURL)
		writeMetaProp(&b, "og:image:width", "720")
		writeMetaProp(&b, "og:image:height", "720")
	}
	writeMetaProp(&b, "og:video", m.VideoURL)
	writeMetaProp(&b, "og:video:url", m.VideoURL)
	writeMetaProp(&b, "og:video:secure_url", m.VideoURL)
	writeMetaProp(&b, "og:video:type", "video/mp4")
	writeMetaProp(&b, "og:video:width", "720")
	writeMetaProp(&b, "og:video:height", "720")
	writeMetaProp(&b, "og:video:duration", strconv.Itoa(int(preview.PreviewDuration/time.Second)))
	if m.Artist != "" {
		writeMetaProp(&b, "music:musician", m.Artist)
	}
	if m.Album != "" {
		writeMetaProp(&b, "music:album", m.Album)
	}

	// Twitter card — Discord reads these too as a fallback.
	writeMetaProp(&b, "twitter:card", "player")
	writeMetaProp(&b, "twitter:title", m.Title)
	writeMetaProp(&b, "twitter:description", m.Description)
	writeMetaProp(&b, "twitter:player:stream", m.VideoURL)
	writeMetaProp(&b, "twitter:player:stream:content_type", "video/mp4")
	writeMetaProp(&b, "twitter:player:width", "720")
	writeMetaProp(&b, "twitter:player:height", "720")
	writeMetaProp(&b, "twitter:image", "0")

	b.WriteString("\n</head>\n<body>")
	b.WriteString(`<p>Opening <a href="` + html.EscapeString(m.Landing) + `">Lumen</a>&hellip;</p>`)
	if m.Landing != "" {
		landingJSON, _ := json.Marshal(m.Landing)
		b.WriteString(`<script>if(typeof navigator!=="undefined"){location.replace(` + string(landingJSON) + `)}</script>`)
	}
	b.WriteString("</body>\n</html>\n")
	return b.String()
}

func renderShareEmbedPage(m shareMeta) string {
	var b strings.Builder
	b.Grow(4096)
	b.WriteString("<!doctype html>\n<html lang=\"en\">\n<head>\n")
	b.WriteString(`<meta charset="utf-8">`)
	b.WriteString(`<meta name="viewport" content="width=device-width,initial-scale=1">`)
	writeTitleTag(&b, m.Title, m.Artist)
	writeMetaName(&b, "description", m.Description)
	writeMetaName(&b, "robots", "noindex")
	writeMetaName(&b, "theme-color", m.ThemeColor)
	b.WriteString(`<style>html,body{margin:0;width:100%;height:100%;background:#050505;color:#fff;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{display:grid;place-items:center}.player{position:relative;width:100%;height:100%;min-height:240px;background:#050505}video{display:block;width:100%;height:100%;object-fit:cover;background:#050505}.fallback{position:absolute;left:16px;right:16px;bottom:16px;text-align:center}.fallback a{color:#fff}</style>`)
	b.WriteString("\n</head>\n<body>")
	b.WriteString(`<div class="player">`)
	b.WriteString(`<video controls playsinline preload="metadata"`)
	if m.CoverURL != "" {
		b.WriteString(` poster="` + html.EscapeString(m.CoverURL) + `"`)
	}
	b.WriteString(` src="` + html.EscapeString(m.VideoURL) + `">`)
	b.WriteString(`</video>`)
	if m.Landing != "" {
		b.WriteString(`<p class="fallback"><a href="` + html.EscapeString(m.Landing) + `">Open in Lumen</a></p>`)
	}
	b.WriteString(`</div>`)
	b.WriteString("</body>\n</html>\n")
	return b.String()
}

func writeTitleTag(b *strings.Builder, title, artist string) {
	full := title
	if artist != "" {
		full = title + " — " + artist
	}
	b.WriteString("<title>")
	b.WriteString(html.EscapeString(full))
	b.WriteString("</title>")
}

func writeMetaProp(b *strings.Builder, property, content string) {
	if content == "" {
		return
	}
	b.WriteString(`<meta property="`)
	b.WriteString(html.EscapeString(property))
	b.WriteString(`" content="`)
	b.WriteString(html.EscapeString(content))
	b.WriteString(`">`)
}

func writeMetaName(b *strings.Builder, name, content string) {
	if content == "" {
		return
	}
	b.WriteString(`<meta name="`)
	b.WriteString(html.EscapeString(name))
	b.WriteString(`" content="`)
	b.WriteString(html.EscapeString(content))
	b.WriteString(`">`)
}
