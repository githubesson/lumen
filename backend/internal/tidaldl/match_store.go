package tidaldl

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/githubesson/lumen/internal/dbtext"
	"github.com/githubesson/lumen/internal/library"
)

// Match outcomes recorded in tidal_matches.
const (
	MatchMatched   = "matched"
	MatchUnmatched = "unmatched"
	MatchFailed    = "failed"
)

// matchWaiting selects tracks t that TIDAL matching may still change: live,
// shared local files whose metadata nobody set on purpose (an admin, an
// importer, or an earlier match), that auto-download didn't save (those are
// filed already), and that are due: never tried, or their retry is up.
const matchWaiting = `t.source = 'local' AND t.owner_id IS NULL AND t.deleted_at IS NULL
	AND t.metadata_edited_at IS NULL
	AND NOT EXISTS (SELECT 1 FROM tidal_downloads d
		WHERE d.local_track_id = t.id AND d.status = 'downloaded')
	AND NOT EXISTS (SELECT 1 FROM tidal_matches m
		WHERE m.track_id = t.id AND (m.next_attempt_at IS NULL OR m.next_attempt_at > NOW()))`

// matchSettled holds for a track t nothing has changed for a while. A track
// just ingested may still be getting its metadata from whoever added it (an
// importer, or auto-download filing a saved copy), and that must win.
const matchSettled = `t.updated_at < NOW() - INTERVAL '10 minutes'`

// matchLoose holds for a track t (album a, LEFT JOINed) with no album to go
// by: none at all, or the catch-all ingest files untagged tracks under.
const matchLoose = `(t.album_id IS NULL OR (a.title = '` + library.CatchAllAlbum + `'
	AND a.album_artist_id IS NULL
	AND NOT EXISTS (SELECT 1 FROM track_artists ca WHERE ca.track_id = t.id AND ca.role <> 'composer')))`

// MatchTrack is a library track waiting for a TIDAL match.
type MatchTrack struct {
	ID         uuid.UUID
	Title      string
	Artists    []string // performers, primary first
	ISRC       string
	DurationMS int
	TrackNo    int
	DiscNo     int
	FilePath   string
}

// MatchAlbum is the library album a group of MatchTracks shares.
type MatchAlbum struct {
	ID           uuid.UUID
	Title        string
	Artist       string // album artist, "" when none
	Year         int
	TIDALAlbumID string // the release the album is linked to, if any
}

const matchTrackColumns = `t.id, t.title,
	ARRAY(SELECT ar.name FROM track_artists ta JOIN artists ar ON ar.id = ta.artist_id
	      WHERE ta.track_id = t.id AND ta.role <> 'composer' ORDER BY ta.position, ar.name),
	COALESCE(t.isrc, ''), t.duration_ms, COALESCE(t.track_no, 0), COALESCE(t.disc_no, 0), t.file_path`

type rowScanner interface{ Scan(...any) error }

func scanMatchTrack(row rowScanner) (MatchTrack, error) {
	var t MatchTrack
	err := row.Scan(&t.ID, &t.Title, &t.Artists, &t.ISRC, &t.DurationMS, &t.TrackNo, &t.DiscNo, &t.FilePath)
	return t, err
}

// PendingMatchAlbums lists albums holding tracks waiting for a match, those
// with the newest additions first.
func (s *Store) PendingMatchAlbums(ctx context.Context, limit int) ([]uuid.UUID, error) {
	rows, err := s.db.Query(ctx, `
		SELECT t.album_id
		FROM tracks t
		JOIN albums a ON a.id = t.album_id
		WHERE `+matchWaiting+` AND `+matchSettled+` AND NOT `+matchLoose+`
		GROUP BY t.album_id
		ORDER BY MAX(t.created_at) DESC, t.album_id
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// MatchAlbumTracks loads an album and up to limit of its tracks waiting for
// a match, in album order. An album that is gone has none.
func (s *Store) MatchAlbumTracks(ctx context.Context, albumID uuid.UUID, limit int) (MatchAlbum, []MatchTrack, error) {
	a := MatchAlbum{ID: albumID}
	err := s.db.QueryRow(ctx, `
		SELECT a.title, COALESCE(ar.name, ''), COALESCE(a.release_year, 0), COALESCE(a.tidal_album_id, '')
		FROM albums a LEFT JOIN artists ar ON ar.id = a.album_artist_id
		WHERE a.id = $1`, albumID).Scan(&a.Title, &a.Artist, &a.Year, &a.TIDALAlbumID)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, nil, nil
	}
	if err != nil {
		return a, nil, err
	}
	rows, err := s.db.Query(ctx, `
		SELECT `+matchTrackColumns+`
		FROM tracks t
		JOIN albums a ON a.id = t.album_id
		WHERE t.album_id = $1 AND `+matchWaiting+` AND `+matchSettled+` AND NOT `+matchLoose+`
		ORDER BY COALESCE(t.disc_no, 1), COALESCE(t.track_no, 0), t.title, t.id
		LIMIT $2`, albumID, limit)
	if err != nil {
		return a, nil, err
	}
	defer rows.Close()
	var out []MatchTrack
	for rows.Next() {
		t, err := scanMatchTrack(rows)
		if err != nil {
			return a, nil, err
		}
		out = append(out, t)
	}
	return a, out, rows.Err()
}

// PendingMatchLoose lists tracks waiting for a match that have no album to
// go by, newest first.
func (s *Store) PendingMatchLoose(ctx context.Context, limit int) ([]MatchTrack, error) {
	rows, err := s.db.Query(ctx, `
		SELECT `+matchTrackColumns+`
		FROM tracks t
		LEFT JOIN albums a ON a.id = t.album_id
		WHERE `+matchWaiting+` AND `+matchSettled+` AND `+matchLoose+`
		ORDER BY t.created_at DESC, t.id
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MatchTrack
	for rows.Next() {
		t, err := scanMatchTrack(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// MatchOutcome is what one attempt to match a track came to.
type MatchOutcome struct {
	Status       string // MatchMatched, MatchUnmatched or MatchFailed
	TIDALID      string
	TIDALAlbumID string // the release the track was filed under, if any
	Error        string
}

// RecordMatch stores an attempt's outcome. A match is final; no match is
// tried again after 30 days, in case TIDAL adds the release; a failure backs
// off from 5 minutes, doubling up to a day. A track deleted meanwhile is
// skipped.
func (s *Store) RecordMatch(ctx context.Context, trackID uuid.UUID, o MatchOutcome) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO tidal_matches (track_id, status, tidal_id, tidal_album_id, error, attempts, next_attempt_at)
		SELECT $1, $2, $3, $4, $5, 1, CASE $2
			WHEN 'matched' THEN NULL
			WHEN 'unmatched' THEN NOW() + INTERVAL '30 days'
			ELSE NOW() + INTERVAL '5 minutes' END
		WHERE EXISTS (SELECT 1 FROM tracks WHERE id = $1)
		ON CONFLICT (track_id) DO UPDATE SET
			status = EXCLUDED.status,
			tidal_id = EXCLUDED.tidal_id,
			tidal_album_id = EXCLUDED.tidal_album_id,
			error = EXCLUDED.error,
			attempts = tidal_matches.attempts + 1,
			next_attempt_at = CASE EXCLUDED.status
				WHEN 'failed' THEN NOW() + LEAST(
					INTERVAL '5 minutes' * POWER(2, LEAST(tidal_matches.attempts, 10)),
					INTERVAL '24 hours')
				ELSE EXCLUDED.next_attempt_at END,
			updated_at = NOW()`,
		trackID, o.Status, dbtext.Clean(o.TIDALID), dbtext.Clean(o.TIDALAlbumID), dbtext.Clean(o.Error))
	return err
}

// TrackAlbumHasCover reports whether a track's album has shared artwork; a
// track without an album reports true, as there is nothing to fill.
func (s *Store) TrackAlbumHasCover(ctx context.Context, trackID uuid.UUID) (bool, error) {
	var has bool
	err := s.db.QueryRow(ctx, `
		SELECT t.album_id IS NULL OR COALESCE(a.cover_art_path, '') <> ''
		FROM tracks t LEFT JOIN albums a ON a.id = t.album_id
		WHERE t.id = $1`, trackID).Scan(&has)
	return has, err
}

// MatchSummary counts shared library tracks by TIDAL matching state.
type MatchSummary struct {
	Matched   int `json:"matched"`   // filed by TIDAL's metadata
	Unmatched int `json:"unmatched"` // no confident match; tried again later
	Failed    int `json:"failed"`    // the last attempt hit an error
	Waiting   int `json:"waiting"`   // not tried yet
}

func (s *Store) MatchSummary(ctx context.Context) (MatchSummary, error) {
	var out MatchSummary
	err := s.db.QueryRow(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE m.status = 'matched'),
			COUNT(*) FILTER (WHERE m.status = 'unmatched'),
			COUNT(*) FILTER (WHERE m.status = 'failed'),
			(SELECT COUNT(*) FROM tracks t
			 WHERE `+matchWaiting+`
			   AND NOT EXISTS (SELECT 1 FROM tidal_matches m2 WHERE m2.track_id = t.id))
		FROM tidal_matches m
		JOIN tracks t ON t.id = m.track_id AND t.deleted_at IS NULL`,
	).Scan(&out.Matched, &out.Unmatched, &out.Failed, &out.Waiting)
	return out, err
}
