package handlers

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/trackref"
)

type trackLinkReq struct {
	TrackID string `json:"track_id"`
}

// localTrackID parses a library track id, bare or "local:"-prefixed.
func localTrackID(raw string) (uuid.UUID, bool) {
	ref, err := trackref.Parse(strings.TrimSpace(raw))
	if err != nil || ref.Source != trackref.SourceLocal || ref.LocalID == uuid.Nil {
		return uuid.Nil, false
	}
	return ref.LocalID, true
}

// Link links another library track with this one as a file of the same song
// (POST /admin/tracks/{id}/links, {"track_id": ...}). Admin only. The
// fullest-tagged of them stays in the library and the best file plays for
// all (library.LinkTracks). Responds with the shown track as Get has it.
func (h *Tracks) Link(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	id, ok := localTrackID(chi.URLParam(r, "id"))
	if !ok {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	var req trackLinkReq
	if !decodeJSON(w, r, &req) {
		return
	}
	other, ok := localTrackID(req.TrackID)
	if !ok {
		http.Error(w, "bad track_id", http.StatusBadRequest)
		return
	}
	shown, err := h.Library.LinkTracks(r.Context(), id, other)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	h.log().Info("tracks linked", "track", id, "other", other, "shown", shown, "user", u.ID)
	h.writeTrackDetail(w, r, shown, u.ID)
}

// Unlink takes a track out of its linked group, back into the library as a
// track of its own (DELETE /admin/tracks/{id}/links). Admin only. Responds
// with the group's shown track afterwards, as Get has it: the track itself
// when nothing is left linked to it.
func (h *Tracks) Unlink(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	id, ok := localTrackID(chi.URLParam(r, "id"))
	if !ok {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	shown, err := h.Library.UnlinkTrack(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	h.log().Info("track unlinked", "track", id, "shown", shown, "user", u.ID)
	h.writeTrackDetail(w, r, shown, u.ID)
}
