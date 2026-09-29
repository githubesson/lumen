package handlers

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubesson/lumen/internal/dbutil"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/models"
	"github.com/githubesson/lumen/internal/pathsafe"
	"github.com/githubesson/lumen/internal/playlists"
	"github.com/githubesson/lumen/internal/users"
)

type AdminUsers struct {
	DB        *pgxpool.Pool
	Users     *users.Store
	Playlists *playlists.Store
	// Library and MusicRoot let Delete remove the user's uploaded files; with
	// either unset the files are left on disk.
	Library   *library.Store
	MusicRoot string
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

	newOwners := map[uuid.UUID]uuid.UUID{}
	for pid, d := range dispoByID {
		if d.Action != "transfer" {
			continue
		}
		newOwner, err := uuid.Parse(d.NewOwnerID)
		if err != nil {
			http.Error(w, "bad new_owner_id", http.StatusBadRequest)
			return
		}
		if newOwner == uid {
			http.Error(w, "cannot transfer to the user being deleted", http.StatusBadRequest)
			return
		}
		newOwners[pid] = newOwner
	}

	// Every handover and the delete itself commit together or not at all, so
	// a failure can't leave some playlists moved or gone and the user intact.
	var uploads []string
	err = dbutil.WithTx(r.Context(), h.DB, func(tx pgx.Tx) error {
		if err := keepAnAdmin(r.Context(), tx, uid); err != nil {
			return err
		}
		// Lock the account. Creating a playlist takes a key-share lock
		// on its owner's row, so no playlist can appear for them from here on;
		// one being created right now commits first and is listed below.
		if _, err := tx.Exec(r.Context(), `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, uid); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `SELECT id FROM playlists WHERE owner_id = $1 FOR UPDATE`, uid)
		if err != nil {
			return err
		}
		owned, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
		if err != nil {
			return err
		}
		for _, pid := range owned {
			if _, ok := dispoByID[pid]; !ok {
				return errMissingDisposition
			}
		}
		for _, pid := range owned {
			newOwner, transfer := newOwners[pid]
			if !transfer {
				if _, err := tx.Exec(r.Context(), `DELETE FROM playlists WHERE id = $1`, pid); err != nil {
					return err
				}
				continue
			}
			var exists bool
			if err := tx.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)`, newOwner).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return errNewOwnerNotFound
			}
			if err := playlists.TransferOwnershipTx(r.Context(), tx, pid, newOwner); err != nil {
				return err
			}
		}
		// Their uploads' paths, read before the delete cascades their tracks.
		if h.Library != nil && h.MusicRoot != "" {
			if uploads, err = library.PersonalUploadPaths(r.Context(), tx, uid); err != nil {
				return err
			}
		}
		// `users.id` has ON DELETE CASCADE for sessions and their own tracks;
		// invites.created_by / tracks.added_by become NULL.
		_, err = tx.Exec(r.Context(), `DELETE FROM users WHERE id = $1`, uid)
		return err
	})
	switch {
	case errors.Is(err, errMissingDisposition):
		owned, err := h.Playlists.OwnedPlaylists(r.Context(), uid)
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		h.writePreview(w, r, target, owned)
		return
	case errors.Is(err, errNewOwnerNotFound):
		http.Error(w, "new_owner_id not found", http.StatusBadRequest)
		return
	case errors.Is(err, errLastAdmin):
		http.Error(w, "cannot delete the last enabled admin", http.StatusBadRequest)
		return
	case errors.Is(err, errUserNotFound):
		http.Error(w, "not found", http.StatusNotFound)
		return
	case err != nil:
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// The account is gone, so say so now rather than after the file cleanup,
	// which mustn't die with the request either (a closed tab, the deadline).
	w.WriteHeader(http.StatusNoContent)
	_ = http.NewResponseController(w).Flush()
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 30*time.Second)
	defer cancel()
	h.removeUploads(cleanupCtx, uid, uploads)
}

var (
	errMissingDisposition = errors.New("an owned playlist has no disposition")
	errNewOwnerNotFound   = errors.New("new owner not found")
	errLastAdmin          = errors.New("no other enabled admin would remain")
	errUserNotFound       = errors.New("user not found")
)

// removeUploads deletes a deleted user's uploaded files. Only files inside
// their own MUSIC_ROOT/.users/<id>/ that no remaining track or alias points
// at are removed: a personal upload can have been adopted by a global track,
// and that file must stay. Failures are logged, not surfaced, since the
// account is already gone and .users/ is never scanned, so a leftover file is
// only wasted space.
func (h *AdminUsers) removeUploads(ctx context.Context, uid uuid.UUID, paths []string) {
	if len(paths) == 0 {
		return
	}
	userDir := filepath.Join(h.MusicRoot, ".users", uid.String())
	for _, p := range paths {
		if inDir, _ := pathsafe.WithinRoot(userDir, p); !inDir {
			continue
		}
		inUse, err := h.Library.FilePathInUse(ctx, p)
		if err != nil || inUse {
			continue
		}
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.Warn("delete user: removing an uploaded file failed", "path", p, "user", uid, "err", err)
		}
	}
	// Only succeeds once it's empty, which leaves adopted files in place.
	_ = os.Remove(userDir)
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
	err := dbutil.WithTx(r.Context(), h.DB, func(tx pgx.Tx) error {
		if err := keepAnAdmin(r.Context(), tx, uid); err != nil {
			return err
		}
		tag, err := tx.Exec(r.Context(), `UPDATE users SET disabled = TRUE, updated_at = NOW() WHERE id = $1`, uid)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errUserNotFound
		}
		_, err = tx.Exec(r.Context(), `DELETE FROM sessions WHERE user_id = $1`, uid)
		return err
	})
	switch {
	case errors.Is(err, errUserNotFound):
		http.Error(w, "not found", http.StatusNotFound)
	case errors.Is(err, errLastAdmin):
		http.Error(w, "cannot disable the last enabled admin", http.StatusBadRequest)
	case err != nil:
		http.Error(w, "internal error", http.StatusInternalServerError)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// adminGuardLock serializes every change that could leave no enabled admin
// (disabling or deleting one), so two admins acting on each other at once
// can't both pass the check.
const adminGuardLock int64 = 0x6c756d656e61646d // "lumenadm"

// keepAnAdmin locks the admin guard for the rest of tx, then fails with
// errLastAdmin if uid is an admin and no other enabled admin would remain.
// Call it first in the transaction, so the lock order is the same everywhere.
func keepAnAdmin(ctx context.Context, tx pgx.Tx, uid uuid.UUID) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, adminGuardLock); err != nil {
		return err
	}
	var role string
	err := tx.QueryRow(ctx, `SELECT role FROM users WHERE id = $1`, uid).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return errUserNotFound
	}
	if err != nil || role != string(models.RoleAdmin) {
		return err
	}
	var others int
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = FALSE AND id <> $1`,
		uid).Scan(&others); err != nil {
		return err
	}
	if others == 0 {
		return errLastAdmin
	}
	return nil
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
	// Without this a mid-iteration connection reset or statement timeout would
	// serialize a truncated user list as 200 — a disabled account simply
	// appears to have vanished.
	if err := rows.Err(); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
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
