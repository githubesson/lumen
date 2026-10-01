package library

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/githubesson/lumen/internal/dbtext"
)

// TIDALTrackFields is the TIDAL metadata a library track matched to a TIDAL
// track takes: what auto-download writes into a saved copy's tags.
type TIDALTrackFields struct {
	Title   string
	Artists []string // ordered, primary first
	ISRC    string
	// Album is the release the track is filed under, with its year and the
	// track's disc and number; a blank Title leaves the album alone.
	Album TIDALAlbumFields
	// KeepAlbum leaves the track in its album, one already linked to the
	// release, while it still takes the release's year and numbering.
	KeepAlbum bool
	// Source is the track as the match was decided for it.
	Source MatchSource
}

// MatchSource is a track as a TIDAL match was decided for it. A track that
// no longer fits it (moved, changed, or its album linked to a release
// meanwhile) is left alone: the decision was made on what it was.
type MatchSource struct {
	Album     *uuid.UUID // the album it was in; nil for none
	AlbumLink string     // that album's TIDAL release link then
	// Seen, if set, is its updated_at then; a duplicate's tags adopted
	// since bump it.
	Seen *time.Time
	// Copies is the sorted list of TIDAL tracks auto-download had found it
	// to be a copy of; a new association since is newer evidence.
	Copies string
}

// ErrTIDALAlbumConflict reports that the library album for a release's
// title and album artist can't take the release: it is linked to another
// release (a track filed there would follow that one), or an admin edited
// it.
var ErrTIDALAlbumConflict = errors.New("the library album for this release is linked to another release or was edited")

// lockSource locks (shared) the album a match was decided for, so an edit
// or a link can't land before the caller commits, and reports whether it is
// still unedited and linked as it was, or to release: the one being
// applied, which an earlier track of the same batch may have linked it to.
// It runs before the caller upserts the album the track moves to, which may
// be the same row, and before the track is locked: albums before tracks, in
// the order ingest takes them, so the two can't deadlock.
func lockSource(ctx context.Context, tx pgx.Tx, src MatchSource, release string) (bool, error) {
	if src.Album == nil {
		return true, nil
	}
	var (
		edited bool
		link   string
	)
	err := tx.QueryRow(ctx, `
		SELECT metadata_edited_at IS NOT NULL, COALESCE(tidal_album_id, '')
		FROM albums WHERE id = $1 FOR SHARE`, *src.Album).Scan(&edited, &link)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return !edited && (link == src.AlbumLink || (release != "" && link == release)), nil
}

// lockTrack locks a live, shared local track whose metadata nobody set on
// purpose and that still fits src (same album, unchanged): the only kind
// TIDAL matching may change. ok is false for any other track.
func lockTrack(ctx context.Context, tx pgx.Tx, trackID uuid.UUID, src MatchSource) (ok bool, err error) {
	// Locked first, checked in the next statement: a writer holding the row
	// (auto-download's adoption share-locks it while it records a copy) has
	// committed by then, and the check sees what it wrote.
	if _, err := tx.Exec(ctx, `SELECT 1 FROM tracks WHERE id = $1 FOR UPDATE`, trackID); err != nil {
		return false, err
	}
	err = tx.QueryRow(ctx, `
		SELECT TRUE FROM tracks t
		WHERE t.id = $1 AND t.deleted_at IS NULL AND t.source = 'local'
		  AND t.owner_id IS NULL AND t.metadata_edited_at IS NULL
		  AND t.album_id IS NOT DISTINCT FROM $2
		  AND ($3::timestamptz IS NULL OR t.updated_at = $3)
		  -- Saved by auto-download or brought in by an importer since the
		  -- match was decided: their metadata wins.
		  AND NOT EXISTS (SELECT 1 FROM tidal_downloads d
		                  WHERE d.local_track_id = t.id AND d.status = 'downloaded')
		  AND NOT EXISTS (SELECT 1 FROM api_tracker_downloads ad WHERE ad.track_id = t.id)
		  AND NOT EXISTS (SELECT 1 FROM artistgrid_downloads gd WHERE gd.track_id = t.id)
		  AND COALESCE((SELECT STRING_AGG(cd.tidal_id, ',' ORDER BY cd.tidal_id) FROM tidal_downloads cd
		                WHERE cd.local_track_id = t.id AND cd.status = 'existing'), '') = $4`,
		trackID, src.Album, src.Seen, src.Copies).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return ok, err
}

// releaseAlbum is upsertTIDALAlbum for TIDAL matching, which refuses an
// album an admin edited or one already linked to another release.
func releaseAlbum(ctx context.Context, tx pgx.Tx, in TIDALAlbumFields, oldCover *string) (uuid.UUID, error) {
	id, err := upsertTIDALAlbum(ctx, tx, in, oldCover)
	if err != nil {
		return id, err
	}
	var (
		linked string
		edited bool
	)
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(tidal_album_id, ''), metadata_edited_at IS NOT NULL FROM albums WHERE id = $1`, id).
		Scan(&linked, &edited); err != nil {
		return uuid.Nil, err
	}
	// Linked to any other release, or to one at all when the hit names
	// none: the link can't be shown to agree.
	if edited || linked != in.TIDALAlbumID {
		return uuid.Nil, ErrTIDALAlbumConflict
	}
	// Filed by the release, the album takes its year over one from tags.
	if in.Year > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE albums SET release_year = $2, updated_at = NOW()
			WHERE id = $1 AND release_year IS DISTINCT FROM $2`, id, in.Year); err != nil {
			return uuid.Nil, err
		}
	}
	return id, nil
}

// albumCover is the cover of a track's album, which the album the track
// moves to takes when it has none. Read before the track is locked; it is
// only a fallback. The catch-all's cover came from whichever untagged file
// had art first, so it isn't carried.
func albumCover(ctx context.Context, tx pgx.Tx, trackID uuid.UUID) (*string, error) {
	var cover *string
	err := tx.QueryRow(ctx, `
		SELECT CASE WHEN a.title = $2 AND a.album_artist_id IS NULL
		                 AND NOT EXISTS (SELECT 1 FROM track_artists ta
		                                 WHERE ta.track_id = t.id AND ta.role <> 'composer')
		            THEN NULL ELSE a.cover_art_path END
		FROM tracks t JOIN albums a ON a.id = t.album_id
		WHERE t.id = $1`, trackID, CatchAllAlbum).Scan(&cover)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return cover, err
}

// ApplyTIDALMatch files a local track matched to a TIDAL track by TIDAL's
// metadata, as auto-download files a saved copy: TIDAL's title, artist list
// (composers from the file are kept) and ISRC, and its release, with album
// artist, year, disc and number. It all lands in one transaction, and only
// on a live, shared local track whose metadata nobody set on purpose;
// applied is false for any other. The track then counts as edited, so a
// duplicate file's tags never replace TIDAL's. record, if set, runs in the
// same transaction once the track is updated, with the album the track is
// now in, so the caller's note of the match commits with it or not at all.
// ErrTIDALAlbumConflict leaves the track as it was.
func (s *Store) ApplyTIDALMatch(ctx context.Context, trackID uuid.UUID, in TIDALTrackFields,
	record func(ctx context.Context, tx pgx.Tx, albumID *uuid.UUID) error) (applied bool, err error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)

	// Performers, then the album artist and album, then the track: ingest's
	// order.
	names := performerNames(in.Artists)
	ids := make([]uuid.UUID, 0, len(names))
	roles := make([]string, 0, len(names))
	for i, name := range names {
		id, err := UpsertArtist(ctx, tx, name)
		if err != nil {
			return false, err
		}
		ids = append(ids, id)
		if i == 0 {
			roles = append(roles, "primary")
		} else {
			roles = append(roles, "featured")
		}
	}
	if ok, err := lockSource(ctx, tx, in.Source, in.Album.TIDALAlbumID); err != nil || !ok {
		return false, err
	}
	var (
		albumID               *uuid.UUID
		year, trackNo, discNo int
	)
	switch {
	case in.KeepAlbum:
		year, trackNo, discNo = in.Album.Year, in.Album.TrackNo, in.Album.DiscNo
	case strings.TrimSpace(in.Album.Title) != "":
		oldCover, err := albumCover(ctx, tx, trackID)
		if err != nil {
			return false, err
		}
		id, err := releaseAlbum(ctx, tx, in.Album, oldCover)
		if err != nil {
			return false, err
		}
		albumID = &id
		year, trackNo, discNo = in.Album.Year, in.Album.TrackNo, in.Album.DiscNo
	}
	if ok, err := lockTrack(ctx, tx, trackID, in.Source); err != nil || !ok {
		return false, err
	}
	if albumID == nil {
		albumID = in.Source.Album
	}
	if _, err := tx.Exec(ctx, `
		UPDATE tracks SET
			title    = COALESCE(NULLIF($2, ''), title),
			isrc     = COALESCE(NULLIF($3, ''), isrc),
			album_id = COALESCE($4, album_id),
			year     = COALESCE(NULLIF($5, 0), year),
			track_no = COALESCE(NULLIF($6, 0), track_no),
			disc_no  = COALESCE(NULLIF($7, 0), disc_no),
			metadata_edited_at = NOW(),
			updated_at = NOW()
		WHERE id = $1`,
		trackID, dbtext.Clean(strings.TrimSpace(in.Title)), dbtext.Clean(strings.TrimSpace(in.ISRC)),
		albumID, year, trackNo, discNo); err != nil {
		return false, err
	}
	if len(ids) > 0 {
		if err := relinkArtists(ctx, tx, trackID, ids, roles, false); err != nil {
			return false, err
		}
	}
	if record != nil {
		if err := record(ctx, tx, albumID); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

// FileUnderTIDALRelease moves a local track into the library album for a
// TIDAL release without taking any other TIDAL metadata, filling only a
// missing year: for the tracks of a matched album that the release doesn't
// list, so the album isn't split. Like ApplyTIDALMatch it only touches a
// live, shared local track whose metadata nobody set on purpose, and
// reports whether it did; ErrTIDALAlbumConflict leaves it as it was. The
// track doesn't count as edited. A track that no longer fits src is left
// alone. record, if set, runs in the same transaction, so the caller's note
// of the outcome commits with the move or not at all.
func (s *Store) FileUnderTIDALRelease(ctx context.Context, trackID uuid.UUID, src MatchSource,
	in TIDALAlbumFields, record func(context.Context, pgx.Tx) error) (bool, error) {
	if strings.TrimSpace(in.Title) == "" {
		return false, errors.New("album title is required")
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)

	if ok, err := lockSource(ctx, tx, src, in.TIDALAlbumID); err != nil || !ok {
		return false, err
	}
	oldCover, err := albumCover(ctx, tx, trackID)
	if err != nil {
		return false, err
	}
	albumID, err := releaseAlbum(ctx, tx, in, oldCover)
	if err != nil {
		return false, err
	}
	if ok, err := lockTrack(ctx, tx, trackID, src); err != nil || !ok {
		return false, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE tracks SET
			album_id = $2,
			year = COALESCE(NULLIF(year, 0), NULLIF($3, 0)),
			updated_at = NOW()
		WHERE id = $1`, trackID, albumID, in.Year); err != nil {
		return false, err
	}
	if record != nil {
		if err := record(ctx, tx); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

// performerNames cleans a TIDAL artist list for linking: blanks and
// case-insensitive repeats dropped, at most MaxTrackArtists.
func performerNames(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, name := range in {
		name = strings.TrimSpace(dbtext.Clean(name))
		key := strings.ToLower(name)
		if name == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, name)
		if len(out) == MaxTrackArtists {
			break
		}
	}
	return out
}
