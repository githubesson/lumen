package playlists

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubesson/lumen/internal/dbutil"
)

var (
	ErrNotFound  = errors.New("playlist not found")
	ErrForbidden = errors.New("forbidden")
)

type Visibility string

const (
	VisibilityPrivate       Visibility = "private"
	VisibilityCollaborative Visibility = "collaborative"
)

type CollaboratorRole string

const (
	RoleViewer CollaboratorRole = "viewer"
	RoleEditor CollaboratorRole = "editor"
)

type CollaboratorStatus string

const (
	StatusPending  CollaboratorStatus = "pending"
	StatusAccepted CollaboratorStatus = "accepted"
)

type Playlist struct {
	ID          uuid.UUID
	OwnerID     uuid.UUID
	Name        string
	Description string
	Visibility  Visibility
	IsSmart     bool
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type Collaborator struct {
	PlaylistID uuid.UUID
	UserID     uuid.UUID
	Username   string
	Role       CollaboratorRole
	Status     CollaboratorStatus
	InvitedAt  time.Time
	AcceptedAt *time.Time
}

type TrackEntry struct {
	Position int
	TrackID  uuid.UUID
	AddedBy  *uuid.UUID
	AddedAt  time.Time
}

type Store struct{ db *pgxpool.Pool }

func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db} }

func (s *Store) DB() *pgxpool.Pool { return s.db }

func (s *Store) Create(ctx context.Context, ownerID uuid.UUID, name, description string, visibility Visibility) (*Playlist, error) {
	if visibility == "" {
		visibility = VisibilityPrivate
	}
	p := &Playlist{}
	err := s.db.QueryRow(ctx, `
		INSERT INTO playlists (owner_id, name, description, visibility)
		VALUES ($1, $2, NULLIF($3, ''), $4)
		RETURNING id, owner_id, name, COALESCE(description, ''), visibility, is_smart, created_at, updated_at`,
		ownerID, name, description, visibility,
	).Scan(&p.ID, &p.OwnerID, &p.Name, &p.Description, &p.Visibility, &p.IsSmart, &p.CreatedAt, &p.UpdatedAt)
	return p, err
}

func (s *Store) Get(ctx context.Context, id uuid.UUID) (*Playlist, error) {
	p := &Playlist{}
	err := s.db.QueryRow(ctx, `
		SELECT id, owner_id, name, COALESCE(description, ''), visibility, is_smart, created_at, updated_at
		FROM playlists WHERE id = $1`, id,
	).Scan(&p.ID, &p.OwnerID, &p.Name, &p.Description, &p.Visibility, &p.IsSmart, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return p, err
}

// ListForUser returns playlists the user owns or is an accepted collaborator on.
// Private playlists are owner-only; collaborator access only applies while the
// playlist is collaborative.
func (s *Store) ListForUser(ctx context.Context, userID uuid.UUID) ([]*Playlist, error) {
	rows, err := s.db.Query(ctx, `
		SELECT p.id, p.owner_id, p.name, COALESCE(p.description, ''), p.visibility, p.is_smart, p.created_at, p.updated_at
		FROM playlists p
		LEFT JOIN playlist_collaborators pc
		  ON pc.playlist_id = p.id
		 AND pc.user_id = $1
		 AND pc.status = 'accepted'
		 AND p.visibility = 'collaborative'
		WHERE p.owner_id = $1 OR pc.user_id IS NOT NULL
		ORDER BY p.updated_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Playlist
	for rows.Next() {
		p := &Playlist{}
		if err := rows.Scan(&p.ID, &p.OwnerID, &p.Name, &p.Description, &p.Visibility, &p.IsSmart, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// Update changes name/description/visibility. Owner-only, enforced by caller.
func (s *Store) Update(ctx context.Context, id uuid.UUID, name, description string, visibility Visibility) error {
	return dbutil.WithTx(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE playlists SET name = $2, description = NULLIF($3, ''), visibility = $4, updated_at = NOW()
			WHERE id = $1`, id, name, description, visibility); err != nil {
			return err
		}
		if visibility == VisibilityPrivate {
			if _, err := tx.Exec(ctx, `DELETE FROM playlist_collaborators WHERE playlist_id = $1`, id); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Store) Delete(ctx context.Context, id uuid.UUID) error {
	_, err := s.db.Exec(ctx, `DELETE FROM playlists WHERE id = $1`, id)
	return err
}

// Tracks returns all tracks in a playlist in order.
func (s *Store) Tracks(ctx context.Context, id uuid.UUID) ([]TrackEntry, error) {
	rows, err := s.db.Query(ctx, `
		SELECT position, track_id, added_by, added_at FROM playlist_tracks
		WHERE playlist_id = $1 ORDER BY position ASC`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TrackEntry
	for rows.Next() {
		var te TrackEntry
		if err := rows.Scan(&te.Position, &te.TrackID, &te.AddedBy, &te.AddedAt); err != nil {
			return nil, err
		}
		out = append(out, te)
	}
	return out, rows.Err()
}

// TrackDetail is a playlist entry joined with track + artist + album data so
// the UI can render a full row in one query.
type TrackDetail struct {
	Position        int
	TrackID         uuid.UUID
	Title           string
	AlbumID         *uuid.UUID
	AlbumTitle      string
	TrackNo         int
	DurationMS      int
	Artist          string // primary artists joined with ", "
	Source          string
	ExternalID      string
	ExternalAlbumID string
	CoverURL        string
	AddedBy         *uuid.UUID
	AddedByName     string
	AddedAt         time.Time
	PlayCount       int // viewer's all-time plays of this track
}

// TracksDetailed returns all tracks in a playlist visible to viewerID (global
// tracks + viewer's own personal tracks). Other users' personal tracks are
// silently omitted.
func (s *Store) TracksDetailed(ctx context.Context, id, viewerID uuid.UUID) ([]TrackDetail, error) {
	rows, err := s.db.Query(ctx, `
		SELECT
			pt.position, pt.track_id, t.title, t.album_id, COALESCE(a.title, ''),
			COALESCE(t.track_no, 0), t.duration_ms,
			COALESCE(
				(SELECT STRING_AGG(ar.name, ', ' ORDER BY ta.position)
				 FROM track_artists ta
				 JOIN artists ar ON ar.id = ta.artist_id
				 WHERE ta.track_id = t.id AND ta.role = 'primary'),
				''),
			t.source,
			t.external_id,
			COALESCE(t.external_meta->>'album_id', ''),
			COALESCE(t.external_meta->>'cover_url', ''),
			pt.added_by,
			COALESCE(u.username, ''),
			pt.added_at,
			COALESCE(
				(SELECT COUNT(*) FROM play_history ph
				 WHERE ph.track_id = t.id AND ph.user_id = $2),
				0)::int
		FROM playlist_tracks pt
		JOIN tracks t ON t.id = pt.track_id AND t.deleted_at IS NULL
		LEFT JOIN albums a ON a.id = t.album_id
		LEFT JOIN users u ON u.id = pt.added_by
		WHERE pt.playlist_id = $1
		  AND (t.owner_id IS NULL OR t.owner_id = $2)
		ORDER BY pt.position ASC`, id, viewerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TrackDetail
	for rows.Next() {
		var td TrackDetail
		if err := rows.Scan(
			&td.Position, &td.TrackID, &td.Title, &td.AlbumID, &td.AlbumTitle,
			&td.TrackNo, &td.DurationMS, &td.Artist,
			&td.Source, &td.ExternalID, &td.ExternalAlbumID, &td.CoverURL,
			&td.AddedBy, &td.AddedByName, &td.AddedAt, &td.PlayCount,
		); err != nil {
			return nil, err
		}
		out = append(out, td)
	}
	return out, rows.Err()
}

// AddTracks appends trackIDs to the end of the playlist, preserving order.
func (s *Store) AddTracks(ctx context.Context, id uuid.UUID, trackIDs []uuid.UUID, addedBy uuid.UUID) error {
	if len(trackIDs) == 0 {
		return nil
	}
	return dbutil.WithTx(ctx, s.db, func(tx pgx.Tx) error {
		var maxPos int
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(MAX(position), -1) FROM playlist_tracks WHERE playlist_id = $1`, id,
		).Scan(&maxPos); err != nil {
			return err
		}
		for i, tid := range trackIDs {
			if _, err := tx.Exec(ctx, `
				INSERT INTO playlist_tracks (playlist_id, position, track_id, added_by)
				VALUES ($1, $2, $3, $4)`, id, maxPos+1+i, tid, addedBy); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE playlists SET updated_at = NOW() WHERE id = $1`, id); err != nil {
			return err
		}
		return nil
	})
}

// RemoveTrackAt deletes one position then compacts remaining positions.
func (s *Store) RemoveTrackAt(ctx context.Context, id uuid.UUID, position int) error {
	return dbutil.WithTx(ctx, s.db, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM playlist_tracks WHERE playlist_id = $1 AND position = $2`, id, position)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		// Shift in two steps via negative positions: the PK on
		// (playlist_id, position) is checked per row, so a direct
		// position-1 update collides whenever rows aren't scanned in
		// ascending position order.
		if _, err := tx.Exec(ctx, `
			UPDATE playlist_tracks SET position = -position
			WHERE playlist_id = $1 AND position > $2`, id, position); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE playlist_tracks SET position = -position - 1
			WHERE playlist_id = $1 AND position < 0`, id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE playlists SET updated_at = NOW() WHERE id = $1`, id); err != nil {
			return err
		}
		return nil
	})
}

// ReplaceOrder rewrites positions for a playlist from an ordered slice of
// existing track_ids. Any IDs not currently in the playlist are ignored.
func (s *Store) ReplaceOrder(ctx context.Context, id uuid.UUID, trackIDs []uuid.UUID) error {
	return dbutil.WithTx(ctx, s.db, func(tx pgx.Tx) error {
		// Snapshot current rows keyed by track_id -> added_by, added_at so we
		// preserve attribution across the rewrite.
		existing := map[uuid.UUID]TrackEntry{}
		rows, err := tx.Query(ctx, `
			SELECT position, track_id, added_by, added_at FROM playlist_tracks WHERE playlist_id = $1`, id)
		if err != nil {
			return err
		}
		for rows.Next() {
			var te TrackEntry
			if err := rows.Scan(&te.Position, &te.TrackID, &te.AddedBy, &te.AddedAt); err != nil {
				rows.Close()
				return err
			}
			existing[te.TrackID] = te
		}
		rows.Close()

		if _, err := tx.Exec(ctx, `DELETE FROM playlist_tracks WHERE playlist_id = $1`, id); err != nil {
			return err
		}
		pos := 0
		for _, tid := range trackIDs {
			prev, ok := existing[tid]
			if !ok {
				continue
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO playlist_tracks (playlist_id, position, track_id, added_by, added_at)
				VALUES ($1, $2, $3, $4, $5)`, id, pos, tid, prev.AddedBy, prev.AddedAt); err != nil {
				return err
			}
			pos++
		}
		if _, err := tx.Exec(ctx, `UPDATE playlists SET updated_at = NOW() WHERE id = $1`, id); err != nil {
			return err
		}
		return nil
	})
}

// --- Collaborators ---

// InviteCollaborator creates a pending collaborator row. Only callable on
// collaborative playlists. Re-invites (after decline / removal) replace the
// old row.
func (s *Store) InviteCollaborator(ctx context.Context, playlistID, userID uuid.UUID, role CollaboratorRole) error {
	tag, err := s.db.Exec(ctx, `
		INSERT INTO playlist_collaborators (playlist_id, user_id, role, status)
		SELECT $1, $2, $3, 'pending'
		FROM playlists
		WHERE id = $1 AND visibility = 'collaborative'
		ON CONFLICT (playlist_id, user_id) DO UPDATE
		SET role = EXCLUDED.role,
		    status = 'pending',
		    invited_at = NOW(),
		    accepted_at = NULL`, playlistID, userID, role)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrForbidden
	}
	return err
}

func (s *Store) SetCollaboratorStatus(ctx context.Context, playlistID, userID uuid.UUID, status CollaboratorStatus) error {
	var acceptedAt any
	if status == StatusAccepted {
		acceptedAt = time.Now()
	}
	tag, err := s.db.Exec(ctx, `
		UPDATE playlist_collaborators pc
		SET status = $3, accepted_at = $4
		FROM playlists p
		WHERE pc.playlist_id = $1
		  AND pc.user_id = $2
		  AND pc.status = 'pending'
		  AND p.id = pc.playlist_id
		  AND p.visibility = 'collaborative'`, playlistID, userID, status, acceptedAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) RemoveCollaborator(ctx context.Context, playlistID, userID uuid.UUID) error {
	_, err := s.db.Exec(ctx, `
		DELETE FROM playlist_collaborators WHERE playlist_id = $1 AND user_id = $2`, playlistID, userID)
	return err
}

func (s *Store) SetCollaboratorRole(ctx context.Context, playlistID, userID uuid.UUID, role CollaboratorRole) error {
	_, err := s.db.Exec(ctx, `
		UPDATE playlist_collaborators SET role = $3
		WHERE playlist_id = $1 AND user_id = $2 AND status = 'accepted'`, playlistID, userID, role)
	return err
}

// scanCollaborators drains rows selecting the standard collaborator column
// set (playlist_id, user_id, username, role, status, invited_at, accepted_at).
func scanCollaborators(rows pgx.Rows) ([]Collaborator, error) {
	defer rows.Close()
	var out []Collaborator
	for rows.Next() {
		var c Collaborator
		if err := rows.Scan(&c.PlaylistID, &c.UserID, &c.Username, &c.Role, &c.Status, &c.InvitedAt, &c.AcceptedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) ListCollaborators(ctx context.Context, playlistID uuid.UUID) ([]Collaborator, error) {
	rows, err := s.db.Query(ctx, `
		SELECT pc.playlist_id, pc.user_id, u.username, pc.role, pc.status, pc.invited_at, pc.accepted_at
		FROM playlist_collaborators pc
		JOIN users u ON u.id = pc.user_id
		WHERE pc.playlist_id = $1
		ORDER BY pc.invited_at ASC`, playlistID)
	if err != nil {
		return nil, err
	}
	return scanCollaborators(rows)
}

// PendingInvites lists invites awaiting accept/decline for a given user.
func (s *Store) PendingInvites(ctx context.Context, userID uuid.UUID) ([]Collaborator, error) {
	rows, err := s.db.Query(ctx, `
		SELECT pc.playlist_id, pc.user_id, u.username, pc.role, pc.status, pc.invited_at, pc.accepted_at
		FROM playlist_collaborators pc
		JOIN users u ON u.id = pc.user_id
		JOIN playlists p ON p.id = pc.playlist_id
		WHERE pc.user_id = $1 AND pc.status = 'pending' AND p.visibility = 'collaborative'
		ORDER BY pc.invited_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	return scanCollaborators(rows)
}

type PendingInvite struct {
	PlaylistID   uuid.UUID
	PlaylistName string
	OwnerID      uuid.UUID
	OwnerName    string
	Role         CollaboratorRole
	InvitedAt    time.Time
}

// PendingInvitesDetailed lists pending invites joined with playlist + owner
// info so the UI can present a meaningful accept/decline prompt.
func (s *Store) PendingInvitesDetailed(ctx context.Context, userID uuid.UUID) ([]PendingInvite, error) {
	rows, err := s.db.Query(ctx, `
		SELECT p.id, p.name, p.owner_id, u.username, pc.role, pc.invited_at
		FROM playlist_collaborators pc
		JOIN playlists p ON p.id = pc.playlist_id
		JOIN users u ON u.id = p.owner_id
		WHERE pc.user_id = $1 AND pc.status = 'pending' AND p.visibility = 'collaborative'
		ORDER BY pc.invited_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PendingInvite
	for rows.Next() {
		var p PendingInvite
		if err := rows.Scan(&p.PlaylistID, &p.PlaylistName, &p.OwnerID, &p.OwnerName, &p.Role, &p.InvitedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// EffectiveRole reports what the user can do with the playlist:
//   - "owner"   — full control
//   - "editor"  — can modify tracks
//   - "viewer"  — can view/play only
//   - ""        — no access
func (s *Store) EffectiveRole(ctx context.Context, playlistID, userID uuid.UUID) (string, error) {
	var ownerID uuid.UUID
	var visibility string
	err := s.db.QueryRow(ctx, `SELECT owner_id, visibility FROM playlists WHERE id = $1`, playlistID).Scan(&ownerID, &visibility)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	if ownerID == userID {
		return "owner", nil
	}
	if visibility != string(VisibilityCollaborative) {
		return "", nil
	}
	var role, status string
	err = s.db.QueryRow(ctx, `
		SELECT role, status FROM playlist_collaborators
		WHERE playlist_id = $1 AND user_id = $2`, playlistID, userID).Scan(&role, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if status != "accepted" {
		return "", nil
	}
	return role, nil
}

// OwnedPlaylists returns id/name pairs for playlists owned by userID.
type OwnedPlaylist struct {
	ID   uuid.UUID
	Name string
}

func (s *Store) OwnedPlaylists(ctx context.Context, userID uuid.UUID) ([]OwnedPlaylist, error) {
	rows, err := s.db.Query(ctx, `SELECT id, name FROM playlists WHERE owner_id = $1 ORDER BY created_at ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []OwnedPlaylist
	for rows.Next() {
		var o OwnedPlaylist
		if err := rows.Scan(&o.ID, &o.Name); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// SuggestedHeir picks the oldest-joined editor on the playlist, then falls
// back to the oldest-joined viewer. Returns (uuid.Nil, false) if there are
// no accepted collaborators.
func (s *Store) SuggestedHeir(ctx context.Context, playlistID uuid.UUID) (uuid.UUID, bool, error) {
	var uid uuid.UUID
	err := s.db.QueryRow(ctx, `
		SELECT user_id FROM playlist_collaborators
		WHERE playlist_id = $1 AND status = 'accepted'
		ORDER BY CASE role WHEN 'editor' THEN 0 ELSE 1 END ASC, accepted_at ASC
		LIMIT 1`, playlistID).Scan(&uid)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, false, nil
	}
	if err != nil {
		return uuid.Nil, false, err
	}
	return uid, true, nil
}

// TransferOwnership sets a new owner. If the new owner is currently a
// collaborator, their collaborator row is removed.
func (s *Store) TransferOwnership(ctx context.Context, playlistID, newOwner uuid.UUID) error {
	return dbutil.WithTx(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE playlists SET owner_id = $2, updated_at = NOW() WHERE id = $1`, playlistID, newOwner); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM playlist_collaborators WHERE playlist_id = $1 AND user_id = $2`, playlistID, newOwner); err != nil {
			return err
		}
		return nil
	})
}
