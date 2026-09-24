package handlers

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

// PublicPreviewAudio serves a share snippet's audio as a standalone M4A — the
// "Download audio" option on the share page. It is signed exactly like
// PublicPreview (whose URL it sits beside in PublicInfo) and remuxed from the
// same preview MP4, so the audio and video downloads always match.
func (h *Share) PublicPreviewAudio(w http.ResponseWriter, r *http.Request) {
	req, ok := h.parseSignedMediaRequest(w, r, true)
	if !ok {
		return
	}
	id := req.id.String()
	outPath, cached := h.Preview.CachedAudio(id, req.startSec, req.durationSec)
	if !cached {
		videoPath, ok := h.Preview.CachedPreview(id, req.startSec, req.durationSec)
		if !ok {
			t, ok := h.loadPublicTrack(w, r, req.id, "preview audio serve")
			if !ok {
				return
			}
			var err error
			videoPath, err = h.buildPublicPreview(r, t, req, "preview audio serve")
			if err != nil {
				writePublicBuildError(w, err, "preview generation failed")
				return
			}
		}
		key := publicBuildKey("audio", id, req.startSec, req.durationSec)
		var err error
		outPath, err = buildPublicMedia(r, key, func(ctx context.Context) (string, error) {
			out, err := h.Preview.EnsureAudioBuilt(ctx, id, req.startSec, req.durationSec, videoPath)
			if err != nil {
				slog.Error("preview audio serve: EnsureAudioBuilt failed",
					"track_id", id, "start_sec", req.startSec, "err", err)
			}
			return out, err
		})
		if err != nil {
			writePublicBuildError(w, err, "audio generation failed")
			return
		}
	}
	serveFileAs(w, r, outPath, "audio/mp4", "audio missing", immutableCacheControl(req.exp))
}

func signedPreviewAudioURL(base string, id uuid.UUID, startSec, durationSec int, exp int64, sig string) string {
	url := signedPreviewMediaURL(base, "/api/public/preview-audio/", id, startSec, durationSec, exp, sig)
	// signedPreviewMediaURL always names the file .mp4.
	return strings.Replace(url, id.String()+".mp4?", id.String()+".m4a?", 1)
}
