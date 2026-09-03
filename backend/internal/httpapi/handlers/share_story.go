package handlers

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/preview"
)

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
	durationSec, _, err := requestedPreviewDuration(r.FormValue("duration_sec"), t.DurationMS)
	if err != nil {
		http.Error(w, "bad duration_sec", http.StatusBadRequest)
		return
	}
	maxStart := maximumPreviewStartSec(t.DurationMS, durationSec)
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
		id.String()+"-"+strconv.Itoa(startSec)+"-"+strconv.Itoa(durationSec)+"s-"+uuid.NewString()+"-custom-story-bg.mp4",
	)
	defer os.Remove(outPath)
	defer os.Remove(outPath + ".part")

	err = h.Preview.BuildCustomStoryBackground(r.Context(), preview.Input{
		TrackID:     id.String(),
		AudioPath:   audioPath,
		StartSec:    startSec,
		DurationSec: durationSec,
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
			"duration_sec", durationSec,
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
	if outPath, ok := cached(req.id.String(), req.startSec, req.durationSec); ok {
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
		TrackID:     req.id.String(),
		AudioPath:   audioPath,
		CoverPath:   coverFSPath,
		StartSec:    req.startSec,
		DurationSec: req.durationSec,
		Title:       title,
		Artist:      primaryArtistName(t),
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
			"duration_sec", req.durationSec,
			"background_only", backgroundOnly,
			"audio_path", audioPath,
			"cover_path", coverFSPath,
			"err", err)
		http.Error(w, "story generation failed", http.StatusInternalServerError)
		return
	}
	serveMediaFile(w, r, outPath, "story missing", immutableCacheControl(req.exp))
}
