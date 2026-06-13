package handlers

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/playlists"
	"github.com/githubesson/lumen/internal/tidal"
	"github.com/githubesson/lumen/internal/trackref"
	"github.com/githubesson/lumen/internal/users"
)

type Playlists struct {
	Store   *playlists.Store
	Users   *users.Store
	Library *library.Store
	TIDAL   *tidal.Client
}

type playlistResp struct {
	ID            string `json:"id"`
	OwnerID       string `json:"owner_id"`
	Name          string `json:"name"`
	Description   string `json:"description,omitempty"`
	Visibility    string `json:"visibility"`
	IsSmart       bool   `json:"is_smart"`
	EffectiveRole string `json:"effective_role,omitempty"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
}

func toPlaylistResp(p *playlists.Playlist, role string) playlistResp {
	return playlistResp{
		ID:            p.ID.String(),
		OwnerID:       p.OwnerID.String(),
		Name:          p.Name,
		Description:   p.Description,
		Visibility:    string(p.Visibility),
		IsSmart:       p.IsSmart,
		EffectiveRole: role,
		CreatedAt:     p.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
		UpdatedAt:     p.UpdatedAt.Format("2006-01-02T15:04:05Z07:00"),
	}
}

type createPlaylistReq struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Visibility  string `json:"visibility,omitempty"`
}

func (h *Playlists) Create(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	var req createPlaylistReq
	if !decodeJSON(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		http.Error(w, "name required", http.StatusBadRequest)
		return
	}
	vis := playlists.Visibility(req.Visibility)
	if vis != "" && vis != playlists.VisibilityPrivate && vis != playlists.VisibilityCollaborative {
		http.Error(w, "invalid visibility", http.StatusBadRequest)
		return
	}
	p, err := h.Store.Create(r.Context(), u.ID, req.Name, req.Description, vis)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, toPlaylistResp(p, "owner"))
}

func (h *Playlists) List(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	ps, err := h.Store.ListForUser(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	out := make([]playlistResp, 0, len(ps))
	for _, p := range ps {
		role := "owner"
		if p.OwnerID != u.ID {
			role, _ = h.Store.EffectiveRole(r.Context(), p.ID, u.ID)
		}
		out = append(out, toPlaylistResp(p, role))
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Playlists) Get(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	pid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	p, err := h.Store.Get(r.Context(), pid)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	role, err := h.Store.EffectiveRole(r.Context(), pid, u.ID)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if role == "" {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, toPlaylistResp(p, role))
}

type updatePlaylistReq struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Visibility  string `json:"visibility"`
}

func (h *Playlists) Update(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	pid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	role, err := h.Store.EffectiveRole(r.Context(), pid, u.ID)
	if err != nil || role == "" {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if role != "owner" {
		http.Error(w, "owner-only", http.StatusForbidden)
		return
	}
	var req updatePlaylistReq
	if !decodeJSON(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		http.Error(w, "name required", http.StatusBadRequest)
		return
	}
	vis := playlists.Visibility(req.Visibility)
	if vis != playlists.VisibilityPrivate && vis != playlists.VisibilityCollaborative {
		http.Error(w, "invalid visibility", http.StatusBadRequest)
		return
	}
	if err := h.Store.Update(r.Context(), pid, req.Name, req.Description, vis); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Playlists) Delete(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	pid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	role, err := h.Store.EffectiveRole(r.Context(), pid, u.ID)
	if err != nil || role == "" {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if role != "owner" {
		http.Error(w, "owner-only", http.StatusForbidden)
		return
	}
	if err := h.Store.Delete(r.Context(), pid); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Tracks ---

type tracksResp struct {
	Tracks []trackItem `json:"tracks"`
}

type trackItem struct {
	Position    int    `json:"position"`
	TrackID     string `json:"track_id"`
	DBTrackID   string `json:"db_track_id,omitempty"`
	Source      string `json:"source,omitempty"`
	SourceID    string `json:"source_id,omitempty"`
	Title       string `json:"title"`
	AlbumID     string `json:"album_id,omitempty"`
	AlbumTitle  string `json:"album_title,omitempty"`
	TrackNo     int    `json:"track_no,omitempty"`
	DurationMS  int    `json:"duration_ms"`
	Artist      string `json:"artist,omitempty"`
	AddedByID   string `json:"added_by_id,omitempty"`
	AddedByName string `json:"added_by,omitempty"`
	AddedAt     string `json:"added_at"`
	PlayCount   int    `json:"play_count"`
	CoverURL    string `json:"cover_url,omitempty"`
}

func (h *Playlists) ListTracks(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	pid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	role, err := h.Store.EffectiveRole(r.Context(), pid, u.ID)
	if err != nil || role == "" {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	tracks, err := h.Store.TracksDetailed(r.Context(), pid, u.ID)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	out := tracksResp{Tracks: make([]trackItem, 0, len(tracks))}
	for _, t := range tracks {
		source := sourceOrLocal(t.Source)
		sourceID := t.ExternalID
		if source == trackref.SourceLocal {
			sourceID = t.TrackID.String()
		}
		ti := trackItem{
			Position:    t.Position,
			TrackID:     canonicalTrackRef(source, t.TrackID, t.ExternalID),
			DBTrackID:   t.TrackID.String(),
			Source:      source,
			SourceID:    sourceID,
			Title:       t.Title,
			AlbumTitle:  t.AlbumTitle,
			TrackNo:     t.TrackNo,
			DurationMS:  t.DurationMS,
			Artist:      t.Artist,
			AddedByName: t.AddedByName,
			AddedAt:     t.AddedAt.Format("2006-01-02T15:04:05Z07:00"),
			PlayCount:   t.PlayCount,
			CoverURL:    t.CoverURL,
		}
		if t.AlbumID != nil {
			ti.AlbumID = t.AlbumID.String()
		}
		if t.AddedBy != nil {
			ti.AddedByID = t.AddedBy.String()
		}
		out.Tracks = append(out.Tracks, ti)
	}
	writeJSON(w, http.StatusOK, out)
}

type addTracksReq struct {
	TrackIDs []string `json:"track_ids"`
}

func (h *Playlists) AddTracks(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	pid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	role, err := h.Store.EffectiveRole(r.Context(), pid, u.ID)
	if err != nil || role == "" {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if role != "owner" && role != "editor" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var req addTracksReq
	if !decodeJSON(w, r, &req) {
		return
	}
	ids := make([]uuid.UUID, 0, len(req.TrackIDs))
	for _, s := range req.TrackIDs {
		id, err := resolveTrackRowID(r.Context(), h.Library, h.TIDAL, s, true)
		if err != nil {
			if errors.Is(err, tidal.ErrNotConfigured) {
				http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
				return
			}
			http.Error(w, "bad track id", http.StatusBadRequest)
			return
		}
		ids = append(ids, id)
	}
	if err := h.Store.AddTracks(r.Context(), pid, ids, u.ID); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Playlists) RemoveTrack(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	pid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	role, err := h.Store.EffectiveRole(r.Context(), pid, u.ID)
	if err != nil || role == "" {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if role != "owner" && role != "editor" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	pos, err := strconv.Atoi(chi.URLParam(r, "pos"))
	if err != nil {
		http.Error(w, "bad position", http.StatusBadRequest)
		return
	}
	if err := h.Store.RemoveTrackAt(r.Context(), pid, pos); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type reorderReq struct {
	TrackIDs []string `json:"track_ids"`
}

func (h *Playlists) Reorder(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	pid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	role, err := h.Store.EffectiveRole(r.Context(), pid, u.ID)
	if err != nil || role == "" {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if role != "owner" && role != "editor" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var req reorderReq
	if !decodeJSON(w, r, &req) {
		return
	}
	ids := make([]uuid.UUID, 0, len(req.TrackIDs))
	for _, s := range req.TrackIDs {
		id, err := resolveTrackRowID(r.Context(), h.Library, h.TIDAL, s, true)
		if err != nil {
			if errors.Is(err, tidal.ErrNotConfigured) {
				http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
				return
			}
			http.Error(w, "bad track id", http.StatusBadRequest)
			return
		}
		ids = append(ids, id)
	}
	if err := h.Store.ReplaceOrder(r.Context(), pid, ids); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Collaborators ---

type collaboratorResp struct {
	UserID     string `json:"user_id"`
	Username   string `json:"username"`
	Role       string `json:"role"`
	Status     string `json:"status"`
	InvitedAt  string `json:"invited_at"`
	AcceptedAt string `json:"accepted_at,omitempty"`
}

func toCollabResp(c playlists.Collaborator) collaboratorResp {
	cr := collaboratorResp{
		UserID:    c.UserID.String(),
		Username:  c.Username,
		Role:      string(c.Role),
		Status:    string(c.Status),
		InvitedAt: c.InvitedAt.Format("2006-01-02T15:04:05Z07:00"),
	}
	if c.AcceptedAt != nil {
		cr.AcceptedAt = c.AcceptedAt.Format("2006-01-02T15:04:05Z07:00")
	}
	return cr
}

func (h *Playlists) ListCollaborators(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	pid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	role, err := h.Store.EffectiveRole(r.Context(), pid, u.ID)
	if err != nil || role == "" {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	cs, err := h.Store.ListCollaborators(r.Context(), pid)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	out := make([]collaboratorResp, 0, len(cs))
	for _, c := range cs {
		out = append(out, toCollabResp(c))
	}
	writeJSON(w, http.StatusOK, out)
}

type inviteCollabReq struct {
	Username string `json:"username"`
	Role     string `json:"role"` // "viewer" | "editor"
}

func (h *Playlists) InviteCollaborator(w http.ResponseWriter, r *http.Request) {
	actor, ok := requireUser(w, r)
	if !ok {
		return
	}
	pid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	p, err := h.Store.Get(r.Context(), pid)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if p.OwnerID != actor.ID {
		http.Error(w, "owner-only", http.StatusForbidden)
		return
	}
	if p.Visibility != playlists.VisibilityCollaborative {
		http.Error(w, "playlist is not collaborative", http.StatusBadRequest)
		return
	}

	var req inviteCollabReq
	if !decodeJSON(w, r, &req) {
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	role := playlists.CollaboratorRole(req.Role)
	if role != playlists.RoleViewer && role != playlists.RoleEditor {
		http.Error(w, "role must be viewer or editor", http.StatusBadRequest)
		return
	}
	target, err := h.Users.ByUsername(r.Context(), req.Username)
	if err != nil {
		http.Error(w, "user not found", http.StatusNotFound)
		return
	}
	if target.ID == actor.ID {
		http.Error(w, "cannot invite yourself", http.StatusBadRequest)
		return
	}
	if err := h.Store.InviteCollaborator(r.Context(), pid, target.ID, role); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (h *Playlists) RemoveCollaborator(w http.ResponseWriter, r *http.Request) {
	actor, ok := requireUser(w, r)
	if !ok {
		return
	}
	pid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	uid, ok := pathUUID(w, r, "user_id")
	if !ok {
		return
	}
	p, err := h.Store.Get(r.Context(), pid)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if p.OwnerID != actor.ID && actor.ID != uid {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if err := h.Store.RemoveCollaborator(r.Context(), pid, uid); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type setRoleReq struct {
	Role string `json:"role"`
}

func (h *Playlists) SetCollaboratorRole(w http.ResponseWriter, r *http.Request) {
	actor, ok := requireUser(w, r)
	if !ok {
		return
	}
	pid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	uid, ok := pathUUID(w, r, "user_id")
	if !ok {
		return
	}
	p, err := h.Store.Get(r.Context(), pid)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if p.OwnerID != actor.ID {
		http.Error(w, "owner-only", http.StatusForbidden)
		return
	}
	var req setRoleReq
	if !decodeJSON(w, r, &req) {
		return
	}
	role := playlists.CollaboratorRole(req.Role)
	if role != playlists.RoleViewer && role != playlists.RoleEditor {
		http.Error(w, "role must be viewer or editor", http.StatusBadRequest)
		return
	}
	if err := h.Store.SetCollaboratorRole(r.Context(), pid, uid, role); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Pending invites (per current user) ---

type pendingInviteResp struct {
	PlaylistID   string `json:"playlist_id"`
	PlaylistName string `json:"playlist_name"`
	OwnerID      string `json:"owner_id"`
	OwnerName    string `json:"owner_name"`
	Role         string `json:"role"`
	InvitedAt    string `json:"invited_at"`
}

func (h *Playlists) PendingInvites(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	cs, err := h.Store.PendingInvitesDetailed(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	out := make([]pendingInviteResp, 0, len(cs))
	for _, c := range cs {
		out = append(out, pendingInviteResp{
			PlaylistID:   c.PlaylistID.String(),
			PlaylistName: c.PlaylistName,
			OwnerID:      c.OwnerID.String(),
			OwnerName:    c.OwnerName,
			Role:         string(c.Role),
			InvitedAt:    c.InvitedAt.Format("2006-01-02T15:04:05Z07:00"),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Playlists) AcceptInvite(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	pid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	if err := h.Store.SetCollaboratorStatus(r.Context(), pid, u.ID, playlists.StatusAccepted); err != nil {
		if errors.Is(err, playlists.ErrNotFound) {
			http.Error(w, "invite not found", http.StatusNotFound)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Playlists) DeclineInvite(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	pid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	if err := h.Store.RemoveCollaborator(r.Context(), pid, u.ID); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
