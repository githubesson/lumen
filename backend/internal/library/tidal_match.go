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
	// From is the album the match was decided for (nil: none). A track
	// moved out of it meanwhile is left alone.
	From *uuid.UUID
	// Seen, if set, is the track's updated_at when the match was decided; a
	// track changed since (e.g. a duplicate's tags adopted) is left alone.
	Seen *time.Time
}

// ErrTIDALAlbumConflict reports that the library album for a release's
// title and album artist can't take the release: it is linked to another
// release (a track filed there would follow that one), or an admin edited
// it.
var ErrTIDALAlbumConflict = errors.New("the library album for this release is linked to another release or was edited")

// lockUnmatchable locks a live, shared local track whose metadata nobody set
// on purpose, still in from (the album the caller decided for, nil for
// none), which nobody edited on purpose: the only kind TIDAL matching may
// change. ok is false for any other track. The album is locked first
// (shared), so an edit to it can't land before the caller commits. Callers
// upsert artists and albums before this, so albums are locked before the
// track, in the order ingest takes them, and the two can't deadlock.
// seen, if set, must still be the track's updated_at.
func lockUnmatchable(ctx context.Context, tx pgx.Tx, trackID uuid.UUID, from *uuid.UUID, seen *time.Time) (ok bool, err error) {
	albumID := from
	if albumID != nil {
		var edited bool
		err := tx.QueryRow(ctx, `
			SELECT metadata_edited_at IS NOT NULL FROM albums WHERE id = $1 FOR SHARE`, *albumID).Scan(&edited)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && edited) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
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
		FOR UPDATE`, trackID, albumID, seen).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return ok, err
}

// releaseAlbum is upsertTIDALAlbum for TIDAL matching, which refuses an
// album already linked to another release.
func releaseAlbum(ctx context.Context, tx pgx.Tx, in TIDALAlbumFields, oldCover *string) (uuid.UUID, error) {
	id, err := upsertTIDALAlbum(ctx, tx, in, oldCover)
	if err != nil || in.TIDALAlbumID == "" {
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
	if linked != in.TIDALAlbumID || edited {
		return uuid.Nil, ErrTIDALAlbumConflict
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
		SELECT CASE WHEN a.title = $2 AND a.album_artist_id IS NULL THEN NULL
		            ELSE a.cover_art_path END
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
	if ok, err := lockUnmatchable(ctx, tx, trackID, in.From, in.Seen); err != nil || !ok {
		return false, err
	}
	if albumID == nil {
		albumID = in.From
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
// track doesn't count as edited. from is the album the decision was made
// for and seen (if set) the track's updated_at then; a track moved out of
// it or changed since is left alone.
func (s *Store) FileUnderTIDALRelease(ctx context.Context, trackID uuid.UUID, from *uuid.UUID, seen *time.Time,
	in TIDALAlbumFields) (bool, error) {
	if strings.TrimSpace(in.Title) == "" {
		return false, errors.New("album title is required")
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)

	oldCover, err := albumCover(ctx, tx, trackID)
	if err != nil {
		return false, err
	}
	albumID, err := releaseAlbum(ctx, tx, in, oldCover)
	if err != nil {
		return false, err
	}
	if ok, err := lockUnmatchable(ctx, tx, trackID, from, seen); err != nil || !ok {
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
