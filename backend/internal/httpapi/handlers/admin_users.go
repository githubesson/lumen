package handlers

import (
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubesson/lumen/internal/models"
	"github.com/githubesson/lumen/internal/playlists"
	"github.com/githubesson/lumen/internal/users"
)

type AdminUsers struct {
	DB        *pgxpool.Pool
	Users     *users.Store
	Playlists *playlists.Store
}

type ownedPlaylistItem struct {
	PlaylistID       string `json:"playlist_id"`
	Name             string `json:"name"`
	SuggestedHeirID  string `json:"suggested_heir_id,omitempty"`
	HasCollaborators bool   `json:"has_collaborators"`
}

type departurePreviewResp struct {
	UserID   string              `json:"user_id"`
	Username string              `json:"username"`
	Owned    []ownedPlaylistItem `json:"owned_playlists"`
}

// DeparturePreview returns the list of playlists the target user owns, each
// annotated with a suggested heir (oldest-joined editor, fallback viewer).
// The admin UI uses this to prompt for dispositions before deletion.
func (h *AdminUsers) DeparturePreview(w http.ResponseWriter, r *http.Request) {
	uid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	target, err := h.Users.ByID(r.Context(), uid)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	owned, err := h.Playlists.OwnedPlaylists(r.Context(), uid)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	out := departurePreviewResp{
		UserID:   target.ID.String(),
		Username: target.Username,
		Owned:    make([]ownedPlaylistItem, 0, len(owned)),
	}
	for _, p := range owned {
		heir, ok, err := h.Playlists.SuggestedHeir(r.Context(), p.ID)
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		item := ownedPlaylistItem{
			PlaylistID:       p.ID.String(),
			Name:             p.Name,
			HasCollaborators: ok,
		}
		if ok {
			item.SuggestedHeirID = heir.String()
		}
		out.Owned = append(out.Owned, item)
	}
	writeJSON(w, http.StatusOK, out)
}

type disposition struct {
	PlaylistID string `json:"playlist_id"`
	Action     string `json:"action"` // "transfer" | "delete"
	NewOwnerID string `json:"new_owner_id,omitempty"`
}

type deleteUserReq struct {
	Dispositions []disposition `json:"playlist_dispositions"`
}

// Delete removes a user. The caller must provide a disposition for every
// playlist they own (transfer to a specific user, or delete the playlist).
// A 409 with the preview body is returned if any owned playlist is missing
// a disposition.
func (h *AdminUsers) Delete(w http.ResponseWriter, r *http.Request) {
	actor, ok := requireUser(w, r)
	if !ok {
		return
	}
	uid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	if uid == actor.ID {
		http.Error(w, "cannot delete yourself", http.StatusBadRequest)
		return
	}
	target, err := h.Users.ByID(r.Context(), uid)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	var req deleteUserReq
	if r.ContentLength > 0 {
		if !decodeJSON(w, r, &req) {
			return
		}
	}
	dispoByID := map[uuid.UUID]disposition{}
	for _, d := range req.Dispositions {
		pid, err := uuid.Parse(d.PlaylistID)
		if err != nil {
			http.Error(w, "bad playlist id in disposition", http.StatusBadRequest)
			return
		}
		if d.Action != "transfer" && d.Action != "delete" {
			http.Error(w, "action must be transfer or delete", http.StatusBadRequest)
			return
		}
		dispoByID[pid] = d
	}

	owned, err := h.Playlists.OwnedPlaylists(r.Context(), uid)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Validate all owned playlists have a disposition.
	missing := false
	for _, p := range owned {
		if _, ok := dispoByID[p.ID]; !ok {
			missing = true
			break
		}
	}
	if missing {
		h.writePreview(w, r, target, owned)
		return
	}

	// Apply dispositions in a single tx per playlist — simpler, and keeps the
	// final user delete small.
	for _, p := range owned {
		d := dispoByID[p.ID]
		switch d.Action {
		case "transfer":
			newOwner, err := uuid.Parse(d.NewOwnerID)
			if err != nil {
				http.Error(w, "bad new_owner_id", http.StatusBadRequest)
				return
			}
			if newOwner == uid {
				http.Error(w, "cannot transfer to the user being deleted", http.StatusBadRequest)
				return
			}
			if _, err := h.Users.ByID(r.Context(), newOwner); err != nil {
				http.Error(w, "new_owner_id not found", http.StatusBadRequest)
				return
			}
			if err := h.Playlists.TransferOwnership(r.Context(), p.ID, newOwner); err != nil {
				http.Error(w, "internal error", http.StatusInternalServerError)
				return
			}
		case "delete":
			if err := h.Playlists.Delete(r.Context(), p.ID); err != nil {
				http.Error(w, "internal error", http.StatusInternalServerError)
				return
			}
		}
	}

	// Finally, delete the user. `users.id` has ON DELETE CASCADE for sessions;
	// invites.created_by / tracks.added_by become NULL.
	if _, err := h.DB.Exec(r.Context(), `DELETE FROM users WHERE id = $1`, uid); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// DisableUser sets disabled=true; existing sessions are revoked. Refuses to
// let an admin disable themselves (instant lockout footgun) or to disable the
// last enabled admin (which would leave the system with no recovery path —
// SeedAdmin only fires when the users table is empty).
func (h *AdminUsers) Disable(w http.ResponseWriter, r *http.Request) {
	actor, ok := requireUser(w, r)
	if !ok {
		return
	}
	uid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	if actor != nil && uid == actor.ID {
		http.Error(w, "cannot disable yourself", http.StatusBadRequest)
		return
	}
	target, err := h.Users.ByID(r.Context(), uid)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if target.Role == models.RoleAdmin {
		var others int
		err := h.DB.QueryRow(r.Context(),
			`SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = FALSE AND id <> $1`,
			uid).Scan(&others)
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		if others == 0 {
			http.Error(w, "cannot disable the last enabled admin", http.StatusBadRequest)
			return
		}
	}
	tag, err := h.DB.Exec(r.Context(), `UPDATE users SET disabled = TRUE, updated_at = NOW() WHERE id = $1`, uid)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if tag.RowsAffected() == 0 {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	_, _ = h.DB.Exec(r.Context(), `DELETE FROM sessions WHERE user_id = $1`, uid)
	w.WriteHeader(http.StatusNoContent)
}

func (h *AdminUsers) Enable(w http.ResponseWriter, r *http.Request) {
	uid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	_, err := h.DB.Exec(r.Context(), `UPDATE users SET disabled = FALSE, updated_at = NOW() WHERE id = $1`, uid)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type listUserResp struct {
	ID                string `json:"id"`
	Username          string `json:"username"`
	Role              string `json:"role"`
	Disabled          bool   `json:"disabled"`
	MustResetPassword bool   `json:"must_reset_password"`
	CreatedAt         string `json:"created_at"`
	LastLoginAt       string `json:"last_login_at,omitempty"`
}

func (h *AdminUsers) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, username, role, disabled, must_reset_password, created_at, last_login_at
		FROM users ORDER BY created_at ASC`)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	out := []listUserResp{}
	for rows.Next() {
		var u listUserResp
		var created time.Time
		var lastLogin *time.Time
		if err := rows.Scan(&u.ID, &u.Username, &u.Role, &u.Disabled, &u.MustResetPassword, &created, &lastLogin); err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		u.CreatedAt = created.Format("2006-01-02T15:04:05Z07:00")
		if lastLogin != nil {
			u.LastLoginAt = lastLogin.Format("2006-01-02T15:04:05Z07:00")
		}
		out = append(out, u)
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *AdminUsers) writePreview(w http.ResponseWriter, r *http.Request, target *models.User, owned []playlists.OwnedPlaylist) {
	preview := departurePreviewResp{
		UserID:   target.ID.String(),
		Username: target.Username,
		Owned:    make([]ownedPlaylistItem, 0, len(owned)),
	}
	for _, p := range owned {
		heir, ok, err := h.Playlists.SuggestedHeir(r.Context(), p.ID)
		if err != nil {
			continue
		}
		item := ownedPlaylistItem{
			PlaylistID:       p.ID.String(),
			Name:             p.Name,
			HasCollaborators: ok,
		}
		if ok {
			item.SuggestedHeirID = heir.String()
		}
		preview.Owned = append(preview.Owned, item)
	}
	writeJSON(w, http.StatusConflict, preview)
}
