package playlists

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubesson/lumen/internal/dbutil"
)

var (
	ErrNotFound     = errors.New("playlist not found")
	ErrForbidden    = errors.New("forbidden")
	ErrInvalidOrder = errors.New("playlist order does not match current entries")
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
	if err != nil {
		// Never hand back a half-scanned row alongside an error, matching
		// library.Store.GetTrack.
		return nil, err
	}
	return p, nil
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
	if err != nil {
		return nil, err
	}
	return p, nil
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
		ORDER BY p.updated_at DESC
		LIMIT $2`, userID, maxPlaylistRows)
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
		tag, err := tx.Exec(ctx, `
			UPDATE playlists SET name = $2, description = NULLIF($3, ''), visibility = $4, updated_at = NOW()
			WHERE id = $1`, id, name, description, visibility)
		if err != nil {
			return err
		}
		// Without this a PATCH against a deleted playlist returns 200.
		if tag.RowsAffected() == 0 {
			return ErrNotFound
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
	tag, err := s.db.Exec(ctx, `DELETE FROM playlists WHERE id = $1`, id)
	if err != nil {
		return err
	}
	// Without this DELETE /playlists/{missing-id} returns 204.
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Safety backstops on the result sets that take no paging parameters. Set far
// above any real value so they never truncate a genuine response, but a
// pathological row set cannot be materialized into memory unbounded.
const (
	maxPlaylistTrackRows = 100000
	maxPlaylistRows      = 10000
)

// Tracks returns all tracks in a playlist in order.
func (s *Store) Tracks(ctx context.Context, id uuid.UUID) ([]TrackEntry, error) {
	rows, err := s.db.Query(ctx, `
		SELECT position, track_id, added_by, added_at FROM playlist_tracks
		WHERE playlist_id = $1 ORDER BY position ASC
		LIMIT $2`, id, maxPlaylistTrackRows)
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
		ORDER BY pt.position ASC
		LIMIT $3`, id, viewerID, maxPlaylistTrackRows)
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

// lockPlaylist serializes track-list mutations on a playlist. Locking the
// parent row is preferable to locking the current playlist_tracks rows because
// an empty playlist has no child row to lock, and it also prevents concurrent
// playlist deletion while the mutation is in progress.
func lockPlaylist(ctx context.Context, tx pgx.Tx, id uuid.UUID) error {
	var lockedID uuid.UUID
	err := tx.QueryRow(ctx, `SELECT id FROM playlists WHERE id = $1 FOR UPDATE`, id).Scan(&lockedID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

// AddTracks appends trackIDs to the end of the playlist, preserving order.
func (s *Store) AddTracks(ctx context.Context, id uuid.UUID, trackIDs []uuid.UUID, addedBy uuid.UUID) error {
	if len(trackIDs) == 0 {
		return nil
	}
	return dbutil.WithTx(ctx, s.db, func(tx pgx.Tx) error {
		if err := lockPlaylist(ctx, tx, id); err != nil {
			return err
		}
		var maxPos int
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(MAX(position), -1) FROM playlist_tracks WHERE playlist_id = $1`, id,
		).Scan(&maxPos); err != nil {
			return err
		}
		// One statement, not one per track: the playlist row is held under
		// FOR UPDATE for the whole transaction, so a 1000-id batch issued as
		// 1000 round-trips blocked every concurrent add/remove/reorder on that
		// playlist for the duration, and could outlive the request deadline.
		if _, err := tx.Exec(ctx, `
			INSERT INTO playlist_tracks (playlist_id, position, track_id, added_by)
			SELECT $1, $2 + ord, t.tid, $4
			FROM unnest($3::uuid[]) WITH ORDINALITY AS t(tid, ord)`,
			id, maxPos, trackIDs, addedBy); err != nil {
			return err
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
		if err := lockPlaylist(ctx, tx, id); err != nil {
			return err
		}
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

// orderedEntries returns the current entries in the requested order. For
// duplicate tracks, occurrences are matched in their previous position order,
// which deterministically preserves each occurrence's attribution. A reorder
// must be an exact permutation: silently dropping, adding, or duplicating an
// entry would otherwise turn a stale client request into data loss.
func orderedEntries(existing []TrackEntry, trackIDs []uuid.UUID) ([]TrackEntry, error) {
	if len(existing) != len(trackIDs) {
		return nil, ErrInvalidOrder
	}

	byTrack := make(map[uuid.UUID][]TrackEntry, len(existing))
	for _, entry := range existing {
		byTrack[entry.TrackID] = append(byTrack[entry.TrackID], entry)
	}

	ordered := make([]TrackEntry, 0, len(trackIDs))
	for _, trackID := range trackIDs {
		occurrences := byTrack[trackID]
		if len(occurrences) == 0 {
			return nil, ErrInvalidOrder
		}
		ordered = append(ordered, occurrences[0])
		byTrack[trackID] = occurrences[1:]
	}
	return ordered, nil
}

type reorderEntry struct {
	TrackEntry
	visible bool
}

func mergeVisibleOrder(allEntries []reorderEntry, orderedVisible []TrackEntry) []reorderEntry {
	visibleIndex := 0
	for i := range allEntries {
		if !allEntries[i].visible {
			continue
		}
		allEntries[i].TrackEntry = orderedVisible[visibleIndex]
		visibleIndex++
	}
	return allEntries
}

// ReplaceOrder rewrites the entries visible to viewerID from an exact
// permutation of their current track IDs. Entries owned by another user are
// retained in their existing relative slots, while references to soft-deleted
// tracks are pruned because no client can include them in a reorder request.
func (s *Store) ReplaceOrder(ctx context.Context, id, viewerID uuid.UUID, trackIDs []uuid.UUID) error {
	return dbutil.WithTx(ctx, s.db, func(tx pgx.Tx) error {
		if err := lockPlaylist(ctx, tx, id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			DELETE FROM playlist_tracks pt
			USING tracks t
			WHERE pt.playlist_id = $1
			  AND t.id = pt.track_id
			  AND t.deleted_at IS NOT NULL`, id); err != nil {
			return err
		}

		// Snapshot all remaining entries. Only the viewer-visible projection is
		// validated/reordered; hidden personal entries keep their relative slots.
		var (
			allEntries     []reorderEntry
			visibleEntries []TrackEntry
		)
		rows, err := tx.Query(ctx, `
			SELECT pt.position, pt.track_id, pt.added_by, pt.added_at,
			       (t.owner_id IS NULL OR t.owner_id = $2) AS visible
			FROM playlist_tracks pt
			JOIN tracks t ON t.id = pt.track_id AND t.deleted_at IS NULL
			WHERE pt.playlist_id = $1
			ORDER BY pt.position`, id, viewerID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var entry reorderEntry
			if err := rows.Scan(
				&entry.Position, &entry.TrackID, &entry.AddedBy, &entry.AddedAt,
				&entry.visible,
			); err != nil {
				rows.Close()
				return err
			}
			allEntries = append(allEntries, entry)
			if entry.visible {
				visibleEntries = append(visibleEntries, entry.TrackEntry)
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()

		orderedVisible, err := orderedEntries(visibleEntries, trackIDs)
		if err != nil {
			return err
		}
		allEntries = mergeVisibleOrder(allEntries, orderedVisible)

		if _, err := tx.Exec(ctx, `DELETE FROM playlist_tracks WHERE playlist_id = $1`, id); err != nil {
			return err
		}
		// One statement, not one per entry. Unlike AddTracks the reorder handler
		// applies no length cap (the payload only has to be a permutation), so a
		// single drag on a 5000-track playlist issued 5001 statements inside the
		// locked transaction.
		trackIDCol := make([]uuid.UUID, len(allEntries))
		// pgtype.UUID, not *uuid.UUID: uuid.UUID has a value-receiver Value()
		// method, so pgx routes a []*uuid.UUID through driver.Valuer and panics
		// on the nil element — and added_by is nullable (ON DELETE SET NULL when
		// the adding user is removed).
		addedByCol := make([]pgtype.UUID, len(allEntries))
		addedAtCol := make([]time.Time, len(allEntries))
		for i, entry := range allEntries {
			trackIDCol[i] = entry.TrackID
			if entry.AddedBy != nil {
				addedByCol[i] = pgtype.UUID{Bytes: *entry.AddedBy, Valid: true}
			}
			addedAtCol[i] = entry.AddedAt
		}
		if len(allEntries) > 0 {
			if _, err := tx.Exec(ctx, `
				INSERT INTO playlist_tracks (playlist_id, position, track_id, added_by, added_at)
				SELECT $1, t.ord - 1, t.track_id, t.added_by, t.added_at
				FROM unnest($2::uuid[], $3::uuid[], $4::timestamptz[])
				     WITH ORDINALITY AS t(track_id, added_by, added_at, ord)`,
				id, trackIDCol, addedByCol, addedAtCol); err != nil {
				return err
			}
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
	tag, err := s.db.Exec(ctx, `
		DELETE FROM playlist_collaborators WHERE playlist_id = $1 AND user_id = $2`, playlistID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) SetCollaboratorRole(ctx context.Context, playlistID, userID uuid.UUID, role CollaboratorRole) error {
	tag, err := s.db.Exec(ctx, `
		UPDATE playlist_collaborators SET role = $3
		WHERE playlist_id = $1 AND user_id = $2 AND status = 'accepted'`, playlistID, userID, role)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
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
	rows, err := s.db.Query(ctx, `
		SELECT id, name FROM playlists WHERE owner_id = $1
		ORDER BY created_at ASC LIMIT $2`, userID, maxPlaylistRows)
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
