package tidaldl

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/githubesson/lumen/internal/dbtext"
	"github.com/githubesson/lumen/internal/library"
)

// Match outcomes recorded in tidal_matches.
const (
	MatchMatched   = "matched"
	MatchUnmatched = "unmatched"
	MatchFailed    = "failed"
)

// matchEligible selects tracks t that TIDAL matching may change: live,
// shared local files whose metadata nobody set on purpose (an admin, an
// importer, or an earlier match) and that auto-download didn't save (those
// are filed already). Tracks from the API tracker and ArtistGrid importers
// carry the importer's metadata, which edits before metadata_edited_at
// existed didn't mark, and tracks of an album an admin edited stay in it.
const matchEligible = `t.source = 'local' AND t.owner_id IS NULL AND t.deleted_at IS NULL
	AND t.metadata_edited_at IS NULL
	AND NOT EXISTS (SELECT 1 FROM albums ea WHERE ea.id = t.album_id AND ea.metadata_edited_at IS NOT NULL)
	AND NOT EXISTS (SELECT 1 FROM tidal_downloads d
		WHERE d.local_track_id = t.id AND d.status = 'downloaded')
	AND NOT EXISTS (SELECT 1 FROM api_tracker_downloads ad WHERE ad.track_id = t.id)
	AND NOT EXISTS (SELECT 1 FROM artistgrid_downloads gd WHERE gd.track_id = t.id)`

// matchDue holds for a track t never tried, or whose retry is up.
const matchDue = `NOT EXISTS (SELECT 1 FROM tidal_matches m
		WHERE m.track_id = t.id AND (m.next_attempt_at IS NULL OR m.next_attempt_at > NOW()))`

// matchWaiting selects eligible tracks t that are due.
const matchWaiting = matchEligible + ` AND ` + matchDue

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
	ID uuid.UUID
	// AlbumID is the album the track was in when loaded; it is matched or
	// moved only while still there.
	AlbumID    *uuid.UUID
	Title      string
	Artists    []string // performers, primary first
	ISRC       string
	DurationMS int
	TrackNo    int
	DiscNo     int
	FilePath   string
	// Seen is the track's updated_at when loaded; a track changed since is
	// left for the next attempt.
	Seen time.Time
}

// MatchAlbum is the library album a group of MatchTracks shares.
type MatchAlbum struct {
	ID           uuid.UUID
	Title        string
	Artist       string // album artist, "" when none
	Year         int
	TIDALAlbumID string // the release the album is linked to, if any
	// Tracks counts all of the album's live, shared local tracks, waiting or
	// not.
	Tracks int
	// Unsettled: some of its waiting tracks changed moments ago, so the
	// album waits until they settle and can be judged with the rest.
	Unsettled bool
	// Chosen is the release an attempt cut short chose for the album, kept
	// until none of its tracks is left to file (ReleaseDone).
	Chosen string
}

const matchTrackColumns = `t.id, t.album_id, t.title,
	ARRAY(SELECT ar.name FROM track_artists ta JOIN artists ar ON ar.id = ta.artist_id
	      WHERE ta.track_id = t.id AND ta.role <> 'composer' ORDER BY ta.position, ar.name),
	COALESCE(t.isrc, ''), t.duration_ms, COALESCE(t.track_no, 0), COALESCE(t.disc_no, 0), t.file_path,
	t.updated_at`

// seen is Seen for the final check, nil when unknown.
func (t MatchTrack) seen() *time.Time {
	if t.Seen.IsZero() {
		return nil
	}
	return &t.Seen
}

type rowScanner interface{ Scan(...any) error }

func scanMatchTrack(row rowScanner) (MatchTrack, error) {
	var t MatchTrack
	err := row.Scan(&t.ID, &t.AlbumID, &t.Title, &t.Artists, &t.ISRC, &t.DurationMS, &t.TrackNo, &t.DiscNo,
		&t.FilePath, &t.Seen)
	return t, err
}

// PendingMatchAlbums lists albums holding tracks waiting for a match, all of
// their eligible tracks settled, those with the newest additions first.
func (s *Store) PendingMatchAlbums(ctx context.Context, limit int) ([]uuid.UUID, error) {
	rows, err := s.db.Query(ctx, `
		SELECT e.album_id
		FROM (
			SELECT t.album_id, t.created_at, `+matchSettled+` AS settled, `+matchDue+` AS due
			FROM tracks t
			JOIN albums a ON a.id = t.album_id
			WHERE `+matchEligible+` AND NOT `+matchLoose+`
		) e
		GROUP BY e.album_id
		HAVING BOOL_OR(e.due) AND BOOL_AND(e.settled)
		ORDER BY MAX(e.created_at) FILTER (WHERE e.due) DESC, e.album_id
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

// MatchAlbumTracks loads an album and up to limit of its eligible tracks,
// in album order: the ones due and the ones whose last attempt is still
// resting, so a release is judged against the whole album. An album that is
// gone has none.
func (s *Store) MatchAlbumTracks(ctx context.Context, albumID uuid.UUID, limit int) (MatchAlbum, []MatchTrack, error) {
	a := MatchAlbum{ID: albumID}
	err := s.db.QueryRow(ctx, `
		SELECT a.title, COALESCE(ar.name, ''), COALESCE(a.release_year, 0), COALESCE(a.tidal_album_id, ''),
		       (SELECT COUNT(*) FROM tracks t
		        WHERE t.album_id = a.id AND t.deleted_at IS NULL AND t.source = 'local'
		          AND t.owner_id IS NULL),
		       EXISTS (SELECT 1 FROM tracks t
		               WHERE t.album_id = a.id AND `+matchEligible+` AND NOT `+matchSettled+`),
		       COALESCE((SELECT c.tidal_album_id FROM tidal_match_albums c WHERE c.album_id = a.id), '')
		FROM albums a LEFT JOIN artists ar ON ar.id = a.album_artist_id
		WHERE a.id = $1`, albumID).Scan(&a.Title, &a.Artist, &a.Year, &a.TIDALAlbumID, &a.Tracks,
		&a.Unsettled, &a.Chosen)
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
		WHERE t.album_id = $1 AND `+matchEligible+` AND NOT `+matchLoose+`
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
	// CoverURL is a match's release cover, kept until CoverAlbum, the album
	// it filed the track under, has artwork.
	CoverURL   string
	CoverAlbum *uuid.UUID
	Error      string
}

type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// RecordAlbumUnmatched records every track of an album waiting for a match
// as unmatched, in one statement.
func (s *Store) RecordAlbumUnmatched(ctx context.Context, albumID uuid.UUID, reason string) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO tidal_matches (track_id, status, error, attempts, next_attempt_at)
		SELECT t.id, 'unmatched', $2, 1, NOW() + INTERVAL '30 days'
		FROM tracks t JOIN albums a ON a.id = t.album_id
		WHERE t.album_id = $1 AND `+matchWaiting+` AND NOT `+matchLoose+`
		ON CONFLICT (track_id) DO UPDATE SET
			status = 'unmatched', tidal_id = '', tidal_album_id = '', error = EXCLUDED.error,
			attempts = tidal_matches.attempts + 1, next_attempt_at = EXCLUDED.next_attempt_at,
			cover_url = '', cover_album_id = NULL, cover_retry_at = NULL, updated_at = NOW()`,
		albumID, dbtext.Clean(reason))
	return err
}

// RecordOutcome stores the same outcome for several tracks in one
// statement, e.g. an album's: all of them or none. A track moved to another
// album or changed since it was loaded (MatchTrack.AlbumID, Seen) is left
// out: the outcome was decided on what it was.
func (s *Store) RecordOutcome(ctx context.Context, tracks []MatchTrack, o MatchOutcome) error {
	if len(tracks) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, len(tracks))
	albums := make([]uuid.UUID, len(tracks))
	seen := make([]*time.Time, len(tracks))
	for i, t := range tracks {
		ids[i] = t.ID
		if t.AlbumID != nil {
			albums[i] = *t.AlbumID
		}
		seen[i] = t.seen()
	}
	_, err := s.db.Exec(ctx, `
		INSERT INTO tidal_matches (track_id, status, tidal_id, tidal_album_id, error, attempts,
		                           next_attempt_at, cover_url, cover_album_id)
		SELECT tr.id, $4, $5, $6, $7, 1, `+fmt.Sprintf(outcomeRetry, "$4")+`, '', NULL
		FROM tracks tr
		JOIN unnest($1::uuid[], $2::uuid[], $3::timestamptz[]) AS snap(id, album_id, seen) ON snap.id = tr.id
		WHERE COALESCE(tr.album_id, '00000000-0000-0000-0000-000000000000'::uuid) = snap.album_id
		  AND (snap.seen IS NULL OR tr.updated_at = snap.seen)
		`+outcomeUpsert,
		ids, albums, seen, o.Status, dbtext.Clean(o.TIDALID), dbtext.Clean(o.TIDALAlbumID), dbtext.Clean(o.Error))
	return err
}

// outcomeRetry is a new outcome's next attempt, by its status (the %s
// parameter).
const outcomeRetry = `CASE %s
			WHEN 'matched' THEN NULL
			WHEN 'unmatched' THEN NOW() + INTERVAL '30 days'
			ELSE NOW() + INTERVAL '5 minutes' END`

// outcomeUpsert replaces an earlier outcome; a failure backs off from 5
// minutes, doubling up to a day.
const outcomeUpsert = `
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
			cover_url = EXCLUDED.cover_url,
			cover_album_id = EXCLUDED.cover_album_id,
			cover_retry_at = NULL,
			updated_at = NOW()`

// RecordMatch stores an attempt's outcome for a track this attempt itself
// just changed (filed it), so no snapshot applies. A match is final; no
// match is tried again after 30 days, in case TIDAL adds the release; a
// failure backs off from 5 minutes, doubling up to a day. A track deleted
// meanwhile is skipped.
func (s *Store) RecordMatch(ctx context.Context, trackID uuid.UUID, o MatchOutcome) error {
	return recordMatch(ctx, s.db, trackID, o)
}

// recordMatch is RecordMatch on q, e.g. the transaction applying a match.
func recordMatch(ctx context.Context, q execer, trackID uuid.UUID, o MatchOutcome) error {
	_, err := q.Exec(ctx, `
		INSERT INTO tidal_matches (track_id, status, tidal_id, tidal_album_id, error, attempts,
		                           next_attempt_at, cover_url, cover_album_id)
		SELECT tr.id, $2, $3, $4, $5, 1, `+fmt.Sprintf(outcomeRetry, "$2")+`, $6, $7
		FROM tracks tr WHERE tr.id = $1
		`+outcomeUpsert,
		trackID, o.Status, dbtext.Clean(o.TIDALID), dbtext.Clean(o.TIDALAlbumID), dbtext.Clean(o.Error),
		dbtext.Clean(o.CoverURL), o.CoverAlbum)
	return err
}

// NextMatchRetry is when the earliest failed lookup of a track matching may
// still change is due again, if any.
func (s *Store) NextMatchRetry(ctx context.Context) (time.Time, bool, error) {
	var at *time.Time
	err := s.db.QueryRow(ctx, `
		SELECT MIN(fm.next_attempt_at) FROM tidal_matches fm
		JOIN tracks t ON t.id = fm.track_id
		WHERE fm.status = 'failed' AND `+matchEligible).Scan(&at)
	if err != nil || at == nil {
		return time.Time{}, false, err
	}
	return *at, true, nil
}

// ChooseRelease notes the release chosen for an album before its tracks are
// filed under it.
func (s *Store) ChooseRelease(ctx context.Context, albumID uuid.UUID, tidalAlbumID string) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO tidal_match_albums (album_id, tidal_album_id) VALUES ($1, $2)
		ON CONFLICT (album_id) DO UPDATE SET tidal_album_id = EXCLUDED.tidal_album_id, created_at = NOW()`,
		albumID, dbtext.Clean(tidalAlbumID))
	return err
}

// ReleaseDone drops an album's chosen release once none of its tracks is
// left to file: every eligible track still in the album has an outcome
// recorded since the choice, and not a failure, which would retry under it.
// An older outcome (a track skipped as changed) doesn't count.
func (s *Store) ReleaseDone(ctx context.Context, albumID uuid.UUID) error {
	_, err := s.db.Exec(ctx, `
		DELETE FROM tidal_match_albums c
		WHERE c.album_id = $1 AND NOT EXISTS (
			SELECT 1 FROM tracks t
			LEFT JOIN tidal_matches om ON om.track_id = t.id
			WHERE t.album_id = $1 AND `+matchEligible+`
			  AND (om.track_id IS NULL OR om.status = 'failed' OR om.updated_at < c.created_at))`, albumID)
	return err
}

// CoverTask is a match whose album still waits for the release cover.
type CoverTask struct {
	TrackID  uuid.UUID
	AlbumID  *uuid.UUID // the album the match filed the track under; nil once gone
	CoverURL string
}

// PendingCovers lists matches whose album cover is still to be fetched and
// due for an attempt.
func (s *Store) PendingCovers(ctx context.Context, limit int) ([]CoverTask, error) {
	rows, err := s.db.Query(ctx, `
		SELECT m.track_id, m.cover_album_id, m.cover_url
		FROM tidal_matches m
		WHERE m.cover_url <> '' AND (m.cover_retry_at IS NULL OR m.cover_retry_at <= NOW())
		ORDER BY m.cover_retry_at NULLS FIRST, m.track_id
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CoverTask
	for rows.Next() {
		var c CoverTask
		if err := rows.Scan(&c.TrackID, &c.AlbumID, &c.CoverURL); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// CoverDone drops a track's pending cover: its album has artwork.
func (s *Store) CoverDone(ctx context.Context, trackID uuid.UUID) error {
	_, err := s.db.Exec(ctx, `
		UPDATE tidal_matches SET cover_url = '', cover_retry_at = NULL WHERE track_id = $1`, trackID)
	return err
}

// CoverFailed puts off a track's pending cover for a few hours.
func (s *Store) CoverFailed(ctx context.Context, trackID uuid.UUID) error {
	_, err := s.db.Exec(ctx, `
		UPDATE tidal_matches SET cover_retry_at = NOW() + INTERVAL '6 hours' WHERE track_id = $1`, trackID)
	return err
}

// AlbumHasCover reports whether an album has shared artwork. An album that
// is gone reports true, as there is nothing to fill.
func (s *Store) AlbumHasCover(ctx context.Context, albumID uuid.UUID) (bool, error) {
	var has bool
	err := s.db.QueryRow(ctx, `
		SELECT COALESCE(cover_art_path, '') <> '' FROM albums WHERE id = $1`, albumID).Scan(&has)
	if errors.Is(err, pgx.ErrNoRows) {
		return true, nil
	}
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
	// Outcomes other than a match count only for tracks matching may still
	// change: an edit since ends the retries.
	err := s.db.QueryRow(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE m.status = 'matched'),
			COUNT(*) FILTER (WHERE m.status = 'unmatched' AND `+matchEligible+`),
			COUNT(*) FILTER (WHERE m.status = 'failed' AND `+matchEligible+`),
			(SELECT COUNT(*) FROM tracks t
			 WHERE `+matchEligible+`
			   AND NOT EXISTS (SELECT 1 FROM tidal_matches m2 WHERE m2.track_id = t.id))
		FROM tidal_matches m
		JOIN tracks t ON t.id = m.track_id AND t.deleted_at IS NULL`,
	).Scan(&out.Matched, &out.Unmatched, &out.Failed, &out.Waiting)
	return out, err
}
