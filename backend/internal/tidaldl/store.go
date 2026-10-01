// Package tidaldl saves the TIDAL tracks of opted-in playlists into the local
// library and repoints those playlists at the local copies.
package tidaldl

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubesson/lumen/internal/dbtext"
	"github.com/githubesson/lumen/internal/dbutil"
	"github.com/githubesson/lumen/internal/pinscan"
)

const (
	StatusDownloaded = pinscan.StatusDownloaded // fetched from TIDAL into the library
	StatusExisting   = pinscan.StatusExisting   // matched a track already in the library
	StatusFailed     = pinscan.StatusFailed
)

// DefaultSubdir is where downloads land, under the primary music root, until
// an admin picks another destination.
const DefaultSubdir = "TIDAL"

const settingsKey = "tidal_auto_download"

type Settings struct {
	RootID *uuid.UUID `json:"root_id,omitempty"` // nil = primary music root
	Subdir string     `json:"subdir"`
}

type Store struct{ db *pgxpool.Pool }

func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db} }

func (s *Store) Settings(ctx context.Context) (Settings, error) {
	var raw []byte
	err := s.db.QueryRow(ctx, `SELECT value FROM settings WHERE key = $1`, settingsKey).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return Settings{Subdir: DefaultSubdir}, nil
	}
	if err != nil {
		return Settings{}, err
	}
	var out Settings
	if err := json.Unmarshal(raw, &out); err != nil {
		return Settings{}, err
	}
	return out, nil
}

func (s *Store) SaveSettings(ctx context.Context, in Settings) error {
	raw, err := json.Marshal(in)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, `
		INSERT INTO settings (key, value) VALUES ($1, $2)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
		settingsKey, raw)
	return err
}

// Candidate is a remote TIDAL row sitting in at least one opted-in playlist.
type Candidate struct {
	RowID   uuid.UUID
	TIDALID string
}

// Pending lists TIDAL tracks in opted-in playlists that still need a local
// copy, oldest addition first. Failures stay out until their backoff expires.
func (s *Store) Pending(ctx context.Context, limit int) ([]Candidate, error) {
	rows, err := s.db.Query(ctx, `
		WITH wanted AS (
			SELECT t.id, t.external_id, pt.added_at AS since
			FROM playlist_tracks pt
			JOIN playlists p ON p.id = pt.playlist_id AND p.tidal_auto_download
			JOIN tracks t ON t.id = pt.track_id
			 AND t.source = 'tidal' AND t.external_id <> '' AND t.deleted_at IS NULL
			UNION ALL
			SELECT t.id, t.external_id, r.requested_at
			FROM tidal_download_requests r
			JOIN tracks t ON t.source = 'tidal' AND t.external_id = r.tidal_id AND t.deleted_at IS NULL
		)
		SELECT w.id, w.external_id
		FROM wanted w
		LEFT JOIN tidal_downloads d ON d.tidal_id = w.external_id
		WHERE d.tidal_id IS NULL
		   OR d.status <> 'failed'
		   OR d.next_attempt_at IS NULL
		   OR d.next_attempt_at <= NOW()
		GROUP BY w.id, w.external_id
		ORDER BY MIN(w.since) ASC, w.id ASC
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Candidate
	for rows.Next() {
		var c Candidate
		if err := rows.Scan(&c.RowID, &c.TIDALID); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// StillWanted reports whether a remote row is still in an opted-in playlist
// or requested for download.
// A batch from Pending can go stale while earlier tracks download.
func (s *Store) StillWanted(ctx context.Context, rowID uuid.UUID) (bool, error) {
	var wanted bool
	err := s.db.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM playlist_tracks pt
			JOIN playlists p ON p.id = pt.playlist_id AND p.tidal_auto_download
			WHERE pt.track_id = $1)
		OR EXISTS (
			SELECT 1 FROM tidal_download_requests r
			JOIN tracks t ON t.external_id = r.tidal_id AND t.source = 'tidal'
			WHERE t.id = $1)`, rowID).Scan(&wanted)
	return wanted, err
}

// LocalTrack is a live, shared library track and the file it plays from.
type LocalTrack struct {
	ID       uuid.UUID
	FilePath string
}

// LocalByISRC lists live, shared library tracks for the same recording,
// oldest first. Callers still have to check the file is playable.
func (s *Store) LocalByISRC(ctx context.Context, isrc string) ([]LocalTrack, error) {
	isrc = dbtext.Clean(isrc)
	if isrc == "" {
		return nil, nil
	}
	rows, err := s.db.Query(ctx, `
		SELECT id, file_path FROM tracks
		WHERE source = 'local' AND owner_id IS NULL AND deleted_at IS NULL
		  AND UPPER(isrc) = UPPER($1)
		ORDER BY created_at ASC, id ASC
		LIMIT 20`, isrc)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LocalTrack
	for rows.Next() {
		var t LocalTrack
		if err := rows.Scan(&t.ID, &t.FilePath); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// TrackFilePath returns a track's file path.
func (s *Store) TrackFilePath(ctx context.Context, id uuid.UUID) (string, error) {
	var p string
	err := s.db.QueryRow(ctx, `SELECT file_path FROM tracks WHERE id = $1`, id).Scan(&p)
	return p, err
}

// GlobalByAudioSHA finds the live shared track with this audio, if any.
func (s *Store) GlobalByAudioSHA(ctx context.Context, sha []byte) (LocalTrack, bool, error) {
	var t LocalTrack
	err := s.db.QueryRow(ctx, `
		SELECT id, file_path FROM tracks
		WHERE audio_sha256 = $1 AND owner_id IS NULL AND deleted_at IS NULL AND source = 'local'`,
		sha).Scan(&t.ID, &t.FilePath)
	if errors.Is(err, pgx.ErrNoRows) {
		return LocalTrack{}, false, nil
	}
	if err != nil {
		return LocalTrack{}, false, err
	}
	return t, true, nil
}

// RepointFile moves a track onto another file with the same audio.
func (s *Store) RepointFile(ctx context.Context, id uuid.UUID, path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !dbtext.Valid(path) {
		return errors.New("file path is not valid UTF-8")
	}
	format := strings.ToLower(strings.TrimPrefix(filepath.Ext(path), "."))
	tag, err := s.db.Exec(ctx, `
		UPDATE tracks SET file_path = $2, file_size = $3, format = $4, updated_at = NOW()
		WHERE id = $1 AND deleted_at IS NULL`, id, path, info.Size(), format)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errors.New("track no longer exists")
	}
	return nil
}

// ErrLocalGone reports that the library copy was deleted before adoption.
var ErrLocalGone = errors.New("library copy was deleted before it could be adopted")

// Adoption moves a remote TIDAL row's references onto its local copy.
type Adoption struct {
	RowID    uuid.UUID
	TIDALID  string
	LocalID  uuid.UUID
	Status   string // "" keeps the existing tidal_downloads row untouched
	FilePath string
	Title    string
	Artist   string
}

// Adopt repoints every playlist entry, stat, and play from the remote row to
// the local track, and records the mapping in the same transaction so that a
// `tidal:<id>` reference resolves to the local copy the moment the swap is
// visible. The remote row itself stays so its metadata remains resolvable.
func (s *Store) Adopt(ctx context.Context, in Adoption) error {
	if in.RowID == in.LocalID {
		return errors.New("tidal row and local track are the same")
	}
	return dbutil.WithTx(ctx, s.db, func(tx pgx.Tx) error {
		// Lock the local row first and require it live: a delete or root
		// purge that lands between the caller's checks and this transaction
		// would otherwise receive entries its fallback trigger already ran
		// for, hiding them for good. Row before playlists, as deletes do
		// (their trigger locks playlists after the row), so the two cannot
		// deadlock.
		var live bool
		err := tx.QueryRow(ctx, `
			SELECT TRUE FROM tracks WHERE id = $1 AND deleted_at IS NULL FOR SHARE`,
			in.LocalID).Scan(&live)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrLocalGone
		}
		if err != nil {
			return err
		}
		// Then playlist locks, in id order, matching the lock order of the
		// playlist mutations so a concurrent reorder cannot interleave.
		if _, err := tx.Exec(ctx, `
			SELECT id FROM playlists
			WHERE id IN (SELECT playlist_id FROM playlist_tracks WHERE track_id = $1)
			ORDER BY id
			FOR UPDATE`, in.RowID); err != nil {
			return err
		}
		// Remember each entry's TIDAL id so it can fall back if the copy goes.
		if _, err := tx.Exec(ctx, `
			UPDATE playlist_tracks SET track_id = $2, tidal_origin = $3 WHERE track_id = $1`,
			in.RowID, in.LocalID, in.TIDALID); err != nil {
			return err
		}
		// Stats before history: RecordPlay locks in that order.
		if _, err := tx.Exec(ctx, `
			INSERT INTO user_track_stats
				(user_id, track_id, play_count, last_played_at, rating, favorited, favorited_at)
			SELECT user_id, $2, play_count, last_played_at, rating, favorited, favorited_at
			FROM user_track_stats WHERE track_id = $1
			FOR UPDATE
			ON CONFLICT (user_id, track_id) DO UPDATE SET
				play_count     = user_track_stats.play_count + EXCLUDED.play_count,
				last_played_at = GREATEST(user_track_stats.last_played_at, EXCLUDED.last_played_at),
				rating         = COALESCE(user_track_stats.rating, EXCLUDED.rating),
				favorited_at   = CASE WHEN user_track_stats.favorited
				                      THEN user_track_stats.favorited_at
				                      ELSE EXCLUDED.favorited_at END,
				favorited      = user_track_stats.favorited OR EXCLUDED.favorited`,
			in.RowID, in.LocalID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM user_track_stats WHERE track_id = $1`, in.RowID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE play_history SET track_id = $2 WHERE track_id = $1`,
			in.RowID, in.LocalID); err != nil {
			return err
		}
		if in.Status == "" {
			return nil
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO tidal_downloads (tidal_id, status, local_track_id, file_path, title, artist)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (tidal_id) DO UPDATE SET
				status = EXCLUDED.status,
				local_track_id = EXCLUDED.local_track_id,
				file_path = EXCLUDED.file_path,
				title = EXCLUDED.title,
				artist = EXCLUDED.artist,
				error = '',
				attempts = 0,
				next_attempt_at = NULL,
				updated_at = NOW()`,
			in.TIDALID, in.Status, in.LocalID, dbtext.Clean(in.FilePath),
			dbtext.Clean(in.Title), dbtext.Clean(in.Artist))
		return err
	})
}

// RecordSaved records that localID is the saved copy of tidalID before its
// references are moved. If adoption then fails, the retry finds this mapping
// instead of rediscovering the file by ISRC or audio and calling it existing.
func (s *Store) RecordSaved(ctx context.Context, tidalID string, localID uuid.UUID, status, filePath, title, artist string) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO tidal_downloads (tidal_id, status, local_track_id, file_path, title, artist)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (tidal_id) DO UPDATE SET
			status = EXCLUDED.status,
			local_track_id = EXCLUDED.local_track_id,
			file_path = EXCLUDED.file_path,
			title = EXCLUDED.title,
			artist = EXCLUDED.artist,
			error = '',
			updated_at = NOW()`,
		tidalID, status, localID, dbtext.Clean(filePath), dbtext.Clean(title), dbtext.Clean(artist))
	return err
}

// Retired is a saved TIDAL track whose remote row still holds stats or play
// history, e.g. from a play resolved just before adoption committed.
type Retired struct {
	RowID     uuid.UUID
	TIDALID   string
	LocalID   uuid.UUID
	LocalPath string
}

func (s *Store) RetiredWithHistory(ctx context.Context, limit int) ([]Retired, error) {
	rows, err := s.db.Query(ctx, `
		SELECT r.id, d.tidal_id, l.id, l.file_path
		FROM tidal_downloads d
		JOIN tracks l ON l.id = d.local_track_id AND l.deleted_at IS NULL
		JOIN tracks r ON r.source = 'tidal' AND r.external_id = d.tidal_id AND r.deleted_at IS NULL
		WHERE d.status IN ('downloaded', 'existing')
		  AND (EXISTS (SELECT 1 FROM user_track_stats s WHERE s.track_id = r.id)
		    OR EXISTS (SELECT 1 FROM play_history h WHERE h.track_id = r.id))
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Retired
	for rows.Next() {
		var r Retired
		if err := rows.Scan(&r.RowID, &r.TIDALID, &r.LocalID, &r.LocalPath); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// RequestTracks queues TIDAL tracks of a release for download, returning how
// many weren't queued already. Each needs a remote track row (the worker
// works from those); the caller materializes them first.
func (s *Store) RequestTracks(ctx context.Context, tidalAlbumID string, tidalIDs []string, by uuid.UUID) (int, error) {
	if len(tidalIDs) == 0 {
		return 0, nil
	}
	var requester any // uuid.Nil = nobody in particular
	if by != uuid.Nil {
		requester = by
	}
	tag, err := s.db.Exec(ctx, `
		INSERT INTO tidal_download_requests (tidal_id, tidal_album_id, requested_by)
		SELECT id, $2, $3::uuid FROM unnest($1::text[]) AS id
		ON CONFLICT (tidal_id) DO NOTHING`, tidalIDs, tidalAlbumID, requester)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// CancelAlbumRequests drops a release's queued downloads.
func (s *Store) CancelAlbumRequests(ctx context.Context, tidalAlbumID string) (int64, error) {
	tag, err := s.db.Exec(ctx, `DELETE FROM tidal_download_requests WHERE tidal_album_id = $1`, tidalAlbumID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// ClearRequest drops a track's download request once it is saved.
func (s *Store) ClearRequest(ctx context.Context, tidalID string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM tidal_download_requests WHERE tidal_id = $1`, tidalID)
	return err
}

// SetDownloadAlbum records the TIDAL album a saved track belongs to ("-" for
// none).
func (s *Store) SetDownloadAlbum(ctx context.Context, tidalID, albumID string) error {
	_, err := s.db.Exec(ctx, `UPDATE tidal_downloads SET tidal_album_id = $2 WHERE tidal_id = $1`, tidalID, albumID)
	return err
}

// SavedTrack is a saved TIDAL track and its library copy.
type SavedTrack struct {
	TIDALID string
	LocalID uuid.UUID
}

// DownloadsMissingAlbum lists downloaded tracks whose album hasn't been
// resolved yet: those saved before album metadata was applied.
func (s *Store) DownloadsMissingAlbum(ctx context.Context, limit int) ([]SavedTrack, error) {
	rows, err := s.db.Query(ctx, `
		SELECT d.tidal_id, d.local_track_id
		FROM tidal_downloads d
		JOIN tracks t ON t.id = d.local_track_id AND t.deleted_at IS NULL
		WHERE d.status = 'downloaded' AND d.tidal_album_id = ''
		-- Random, so a track TIDAL keeps failing on can't hold a batch slot.
		ORDER BY random()
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SavedTrack
	for rows.Next() {
		var t SavedTrack
		if err := rows.Scan(&t.TIDALID, &t.LocalID); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// RecordFailure stores the error and schedules a retry with exponential
// backoff: 5 minutes after the first failure, doubling up to a day.
func (s *Store) RecordFailure(ctx context.Context, tidalID, title, artist string, cause error) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO tidal_downloads (tidal_id, status, title, artist, error, attempts, next_attempt_at)
		VALUES ($1, 'failed', $2, $3, $4, 1, NOW() + INTERVAL '5 minutes')
		ON CONFLICT (tidal_id) DO UPDATE SET
			status = 'failed',
			local_track_id = NULL,
			title = COALESCE(NULLIF(EXCLUDED.title, ''), tidal_downloads.title),
			artist = COALESCE(NULLIF(EXCLUDED.artist, ''), tidal_downloads.artist),
			error = EXCLUDED.error,
			attempts = tidal_downloads.attempts + 1,
			next_attempt_at = NOW() + LEAST(
				INTERVAL '5 minutes' * POWER(2, LEAST(tidal_downloads.attempts, 10)),
				INTERVAL '24 hours'),
			updated_at = NOW()`,
		tidalID, dbtext.Clean(title), dbtext.Clean(artist), dbtext.Clean(cause.Error()))
	return err
}

// RetryFailed makes every failed download due immediately.
func (s *Store) RetryFailed(ctx context.Context) (int64, error) {
	tag, err := s.db.Exec(ctx, `
		UPDATE tidal_downloads SET next_attempt_at = NOW(), updated_at = NOW()
		WHERE status = 'failed'`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

type Summary struct {
	Playlists int `json:"playlists"` // playlists with auto-download on
	Queued    int `json:"queued"`    // waiting for their first attempt or a retry
	Failed    int `json:"failed"`    // last attempt failed, still in an opted-in playlist
	Saved     int `json:"saved"`     // TIDAL tracks that have a local copy
}

func (s *Store) Summary(ctx context.Context) (Summary, error) {
	var out Summary
	err := s.db.QueryRow(ctx, `
		WITH wanted AS (
			SELECT t.external_id
			FROM playlist_tracks pt
			JOIN playlists p ON p.id = pt.playlist_id AND p.tidal_auto_download
			JOIN tracks t ON t.id = pt.track_id
			 AND t.source = 'tidal' AND t.external_id <> '' AND t.deleted_at IS NULL
			UNION
			SELECT tidal_id FROM tidal_download_requests
		)
		SELECT
			(SELECT COUNT(*) FROM playlists WHERE tidal_auto_download),
			(SELECT COUNT(*) FROM wanted w
			 LEFT JOIN tidal_downloads d ON d.tidal_id = w.external_id
			 WHERE d.status IS DISTINCT FROM 'failed'),
			(SELECT COUNT(*) FROM wanted w
			 JOIN tidal_downloads d ON d.tidal_id = w.external_id
			 WHERE d.status = 'failed'),
			(SELECT COUNT(*) FROM tidal_downloads
			 WHERE status IN ('downloaded', 'existing') AND local_track_id IS NOT NULL)`,
	).Scan(&out.Playlists, &out.Queued, &out.Failed, &out.Saved)
	return out, err
}

type Download struct {
	TIDALID       string     `json:"tidal_id"`
	Status        string     `json:"status"`
	LocalTrackID  *uuid.UUID `json:"local_track_id,omitempty"`
	FilePath      string     `json:"file_path,omitempty"`
	Title         string     `json:"title,omitempty"`
	Artist        string     `json:"artist,omitempty"`
	Error         string     `json:"error,omitempty"`
	Attempts      int        `json:"attempts"`
	NextAttemptAt *time.Time `json:"next_attempt_at,omitempty"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// Recent returns the latest download outcomes, newest first.
func (s *Store) Recent(ctx context.Context, limit int) ([]Download, error) {
	rows, err := s.db.Query(ctx, `
		SELECT tidal_id, status, local_track_id, file_path, title, artist, error,
		       attempts, next_attempt_at, updated_at
		FROM tidal_downloads
		ORDER BY updated_at DESC
		LIMIT $1`, pinscan.HistoryLimit(limit))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Download{}
	for rows.Next() {
		var d Download
		if err := rows.Scan(&d.TIDALID, &d.Status, &d.LocalTrackID, &d.FilePath, &d.Title,
			&d.Artist, &d.Error, &d.Attempts, &d.NextAttemptAt, &d.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
