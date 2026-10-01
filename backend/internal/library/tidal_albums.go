package library

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/githubesson/lumen/internal/dbtext"
	"github.com/githubesson/lumen/internal/dbutil"
	"github.com/githubesson/lumen/internal/tidal"
)

// TIDALAlbumMaxAge is how long cached TIDAL album metadata is trusted before
// the auto-download worker refetches it.
const TIDALAlbumMaxAge = 7 * 24 * time.Hour

// cachedTIDALTrack is one entry of tidal_albums.tracks.
type cachedTIDALTrack struct {
	ID         string   `json:"id"`
	Title      string   `json:"title"`
	TrackNo    int      `json:"track_no,omitempty"`
	DiscNo     int      `json:"disc_no,omitempty"`
	DurationMS int      `json:"duration_ms,omitempty"`
	Artists    []string `json:"artists,omitempty"`
	ISRC       string   `json:"isrc,omitempty"`
	Removed    bool     `json:"removed,omitempty"`
}

// SaveTIDALAlbum stores a full TIDAL album (every track, not one page). The
// record is kept for good: a later fetch is merged into it, so tracks TIDAL
// stops listing stay (marked removed) and fields it stops returning keep
// their last value.
func (s *Store) SaveTIDALAlbum(ctx context.Context, a tidal.Album) error {
	if strings.TrimSpace(a.ID) == "" {
		return errors.New("tidal album id is required")
	}
	return dbutil.WithTx(ctx, s.db, func(tx pgx.Tx) error {
		fresh := cachedRelease{
			Title: dbtext.Clean(a.Title), Artist: dbtext.Clean(a.Artist), Artists: cleanAll(a.Artists),
			ReleaseYear: a.ReleaseYear, CoverID: dbtext.Clean(a.CoverID), CoverURL: dbtext.Clean(a.CoverURL),
			DurationMS: a.DurationMS,
		}
		for _, t := range a.Tracks {
			fresh.Tracks = append(fresh.Tracks, cachedTIDALTrack{
				ID: t.ID, Title: dbtext.Clean(t.Title), TrackNo: t.TrackNo, DiscNo: t.DiscNo,
				DurationMS: t.DurationMS, Artists: cleanAll(t.Artists), ISRC: dbtext.Clean(t.ISRC),
			})
		}
		var (
			old                     cachedRelease
			artistsJSON, tracksJSON []byte
		)
		err := tx.QueryRow(ctx, `
			SELECT title, artist, artists, release_year, cover_id, cover_url, duration_ms, tracks
			FROM tidal_albums WHERE tidal_id = $1 FOR UPDATE`, a.ID).
			Scan(&old.Title, &old.Artist, &artistsJSON, &old.ReleaseYear, &old.CoverID, &old.CoverURL,
				&old.DurationMS, &tracksJSON)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
		case err != nil:
			return err
		default:
			if err := json.Unmarshal(artistsJSON, &old.Artists); err != nil {
				return err
			}
			if err := json.Unmarshal(tracksJSON, &old.Tracks); err != nil {
				return err
			}
			fresh = mergeCachedRelease(old, fresh)
		}
		if artistsJSON, err = json.Marshal(fresh.Artists); err != nil {
			return err
		}
		if tracksJSON, err = json.Marshal(fresh.Tracks); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO tidal_albums (tidal_id, title, artist, artists, release_year, cover_id, cover_url,
			                          track_count, duration_ms, tracks, fetched_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
			ON CONFLICT (tidal_id) DO UPDATE SET
				title = EXCLUDED.title, artist = EXCLUDED.artist, artists = EXCLUDED.artists,
				release_year = EXCLUDED.release_year, cover_id = EXCLUDED.cover_id,
				cover_url = EXCLUDED.cover_url, track_count = EXCLUDED.track_count,
				duration_ms = EXCLUDED.duration_ms, tracks = EXCLUDED.tracks, fetched_at = NOW()`,
			a.ID, fresh.Title, fresh.Artist, artistsJSON, fresh.ReleaseYear, fresh.CoverID, fresh.CoverURL,
			len(fresh.Tracks), fresh.DurationMS, tracksJSON)
		return err
	})
}

// cachedRelease is a tidal_albums row without its id.
type cachedRelease struct {
	Title, Artist     string
	Artists           []string
	ReleaseYear       int
	CoverID, CoverURL string
	DurationMS        int
	Tracks            []cachedTIDALTrack
}

// mergeCachedTrack keeps a track's stored values for fields a fresh listing
// left empty.
func mergeCachedTrack(old, fresh cachedTIDALTrack) cachedTIDALTrack {
	if strings.TrimSpace(fresh.Title) == "" {
		fresh.Title = old.Title
	}
	if strings.TrimSpace(fresh.ISRC) == "" {
		fresh.ISRC = old.ISRC
	}
	if len(fresh.Artists) == 0 {
		fresh.Artists = old.Artists
	}
	if fresh.DurationMS == 0 {
		fresh.DurationMS = old.DurationMS
	}
	if fresh.TrackNo == 0 {
		fresh.TrackNo = old.TrackNo
	}
	if fresh.DiscNo == 0 {
		fresh.DiscNo = old.DiscNo
	}
	return fresh
}

// mergeCachedRelease folds a fresh fetch into the stored record. Fresh values
// win where TIDAL returned one. Stored tracks the fetch no longer lists are
// kept, marked removed, at their place in disc/track order; a track TIDAL
// lists again is no longer removed.
func mergeCachedRelease(old, fresh cachedRelease) cachedRelease {
	out := fresh
	pick := func(f, o string) string {
		if strings.TrimSpace(f) != "" {
			return f
		}
		return o
	}
	out.Title = pick(fresh.Title, old.Title)
	out.Artist = pick(fresh.Artist, old.Artist)
	out.CoverID = pick(fresh.CoverID, old.CoverID)
	out.CoverURL = pick(fresh.CoverURL, old.CoverURL)
	if len(fresh.Artists) == 0 {
		out.Artists = old.Artists
	}
	if fresh.ReleaseYear == 0 {
		out.ReleaseYear = old.ReleaseYear
	}
	if fresh.DurationMS == 0 {
		out.DurationMS = old.DurationMS
	}

	stored := make(map[string]cachedTIDALTrack, len(old.Tracks))
	for _, t := range old.Tracks {
		stored[t.ID] = t
	}
	listed := map[string]bool{}
	tracks := make([]cachedTIDALTrack, 0, len(fresh.Tracks)+len(old.Tracks))
	for _, t := range fresh.Tracks {
		listed[t.ID] = true
		if o, ok := stored[t.ID]; ok {
			t = mergeCachedTrack(o, t)
		}
		t.Removed = false
		tracks = append(tracks, t)
	}
	before := func(a, b cachedTIDALTrack) bool {
		ad, bd := max(a.DiscNo, 1), max(b.DiscNo, 1)
		if ad != bd {
			return ad < bd
		}
		return a.TrackNo < b.TrackNo
	}
	for _, r := range old.Tracks {
		if listed[r.ID] {
			continue
		}
		r.Removed = true
		at := len(tracks)
		if r.TrackNo > 0 {
			for i, t := range tracks {
				if t.TrackNo > 0 && before(r, t) {
					at = i
					break
				}
			}
		}
		tracks = append(tracks[:at], append([]cachedTIDALTrack{r}, tracks[at:]...)...)
	}
	out.Tracks = tracks
	return out
}

// TIDALAlbum returns a cached TIDAL album and when it was fetched, or
// ErrNotFound.
func (s *Store) TIDALAlbum(ctx context.Context, id string) (tidal.Album, time.Time, error) {
	var (
		a           tidal.Album
		artistsJSON []byte
		tracksJSON  []byte
		fetchedAt   time.Time
	)
	err := s.db.QueryRow(ctx, `
		SELECT tidal_id, title, artist, artists, release_year, cover_id, cover_url,
		       track_count, duration_ms, tracks, fetched_at
		FROM tidal_albums WHERE tidal_id = $1`, strings.TrimSpace(id)).
		Scan(&a.ID, &a.Title, &a.Artist, &artistsJSON, &a.ReleaseYear, &a.CoverID, &a.CoverURL,
			&a.TrackCount, &a.DurationMS, &tracksJSON, &fetchedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return tidal.Album{}, time.Time{}, ErrNotFound
	}
	if err != nil {
		return tidal.Album{}, time.Time{}, err
	}
	if err := json.Unmarshal(artistsJSON, &a.Artists); err != nil {
		return tidal.Album{}, time.Time{}, err
	}
	var tracks []cachedTIDALTrack
	if err := json.Unmarshal(tracksJSON, &tracks); err != nil {
		return tidal.Album{}, time.Time{}, err
	}
	for _, t := range tracks {
		a.Tracks = append(a.Tracks, tidal.Track{
			ID: t.ID, Title: t.Title, TrackNo: t.TrackNo, DiscNo: t.DiscNo, DurationMS: t.DurationMS,
			Artists: t.Artists, ISRC: t.ISRC, Year: a.ReleaseYear, Removed: t.Removed,
			AlbumID: a.ID, AlbumTitle: a.Title, AlbumArtist: a.Artist,
			CoverID: a.CoverID, CoverURL: a.CoverURL,
		})
	}
	return a, fetchedAt, nil
}

// TIDALAlbumFields is the release metadata a saved TIDAL track is filed by.
type TIDALAlbumFields struct {
	TIDALAlbumID string
	Title        string
	Artist       string // primary artist; "" or "Various Artists" = compilation
	Year         int
	TrackNo      int
	DiscNo       int
}

// ApplyTIDALAlbum files a saved TIDAL track under its release: the album
// (title, album artist) is created or reused, keeps the cover of the album
// the track leaves, gets the release year and TIDAL link, and the track gets
// any missing year, track and disc numbers. An album already linked to a
// different release keeps that link.
func (s *Store) ApplyTIDALAlbum(ctx context.Context, trackID uuid.UUID, in TIDALAlbumFields) error {
	if strings.TrimSpace(in.Title) == "" {
		return errors.New("album title is required")
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var oldCover *string
	err = tx.QueryRow(ctx, `
		SELECT a.cover_art_path FROM tracks t
		LEFT JOIN albums a ON a.id = t.album_id
		WHERE t.id = $1 AND t.deleted_at IS NULL
		FOR UPDATE OF t`, trackID).Scan(&oldCover)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	artist := strings.TrimSpace(in.Artist)
	isComp := artist == "" || strings.EqualFold(artist, "Various Artists")
	var artistID *uuid.UUID
	if !isComp {
		id, err := UpsertArtist(ctx, tx, artist)
		if err != nil {
			return err
		}
		artistID = &id
	}
	cover := ""
	if oldCover != nil {
		cover = *oldCover
	}
	albumID, err := UpsertAlbum(ctx, tx, in.Title, artistID, in.Year, isComp, cover, nil)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE tracks SET
			album_id = $2,
			year     = COALESCE(NULLIF(year, 0), NULLIF($3, 0)),
			track_no = COALESCE(NULLIF(track_no, 0), NULLIF($4, 0)),
			disc_no  = COALESCE(NULLIF(disc_no, 0), NULLIF($5, 0)),
			updated_at = NOW()
		WHERE id = $1`, trackID, albumID, in.Year, in.TrackNo, in.DiscNo); err != nil {
		return err
	}
	if in.TIDALAlbumID != "" {
		if _, err := tx.Exec(ctx, `
			UPDATE albums SET
				tidal_album_id = $2,
				release_year = COALESCE(NULLIF(release_year, 0), NULLIF($3, 0)),
				updated_at = NOW()
			WHERE id = $1 AND (tidal_album_id IS NULL OR tidal_album_id = $2)`,
			albumID, in.TIDALAlbumID, in.Year); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// TIDALAlbumReferenced reports whether the library has a stake in a TIDAL
// release: it is already stored, a library album copies it, or downloads are
// queued for it. Only such releases are stored from album page views, so
// browsing can't grow the permanent store without bound.
func (s *Store) TIDALAlbumReferenced(ctx context.Context, tidalAlbumID string) (bool, error) {
	var ok bool
	err := s.db.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM tidal_albums WHERE tidal_id = $1)
		    OR EXISTS (SELECT 1 FROM albums WHERE tidal_album_id = $1)
		    OR EXISTS (SELECT 1 FROM tidal_download_requests WHERE tidal_album_id = $1)`,
		tidalAlbumID).Scan(&ok)
	return ok, err
}

// TIDALAlbumQueued counts tracks of a TIDAL release waiting for an album
// download.
func (s *Store) TIDALAlbumQueued(ctx context.Context, tidalAlbumID string) (int, error) {
	var n int
	err := s.db.QueryRow(ctx, `
		SELECT COUNT(*) FROM tidal_download_requests WHERE tidal_album_id = $1`, tidalAlbumID).Scan(&n)
	return n, err
}

// LocalAlbumForTIDAL returns a library album linked to a TIDAL release that
// has tracks visible to viewerID, or ErrNotFound.
func (s *Store) LocalAlbumForTIDAL(ctx context.Context, tidalAlbumID string, viewerID uuid.UUID) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.db.QueryRow(ctx, `
		SELECT a.id FROM albums a
		WHERE a.tidal_album_id = $1
		  AND EXISTS (
			SELECT 1 FROM tracks t
			WHERE t.album_id = a.id AND t.deleted_at IS NULL AND t.library_visible = TRUE
			  AND `+trackVisibleP2+`)
		ORDER BY a.created_at ASC, a.id ASC
		LIMIT 1`, tidalAlbumID, viewerID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrNotFound
	}
	return id, err
}

// SavedTIDALCopies maps each TIDAL track id in tidalIDs that auto-download
// saved to its library copy, as a track list row. Copies the viewer can't see
// or (with PlayableRoots set) can't play are left out.
func (s *Store) SavedTIDALCopies(ctx context.Context, tidalIDs []string, viewerID uuid.UUID) (map[string]TrackListItem, error) {
	out := map[string]TrackListItem{}
	if len(tidalIDs) == 0 {
		return out, nil
	}
	rows, err := s.db.Query(ctx, `
		SELECT
			d.tidal_id, t.file_path,
			t.id, t.title, t.album_id, COALESCE(a.title, ''),
			COALESCE(t.track_no, 0), t.duration_ms,
			COALESCE(STRING_AGG(ar.name, ', ' ORDER BY ta.position) FILTER (WHERE ta.role = 'primary'), ''),
			`+akaSubquery+`,
			COALESCE(t.owner_id = $2, FALSE) AS owned,
			t.source, t.external_id, COALESCE(t.external_meta->>'cover_url', ''),
			t.created_at
		FROM tidal_downloads d
		JOIN tracks t ON t.id = d.local_track_id AND t.deleted_at IS NULL
		LEFT JOIN albums a ON a.id = t.album_id
		LEFT JOIN track_artists ta ON ta.track_id = t.id
		LEFT JOIN artists ar ON ar.id = ta.artist_id
		WHERE d.tidal_id = ANY($1) AND d.status IN ('downloaded', 'existing')
		  AND `+trackVisibleP2+`
		GROUP BY d.tidal_id, t.id, a.title`, tidalIDs, viewerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var roots []string
	if s.PlayableRoots != nil {
		roots = s.PlayableRoots(ctx)
	}
	for rows.Next() {
		var (
			tidalID, path string
			it            TrackListItem
		)
		if err := rows.Scan(&tidalID, &path, &it.ID, &it.Title, &it.AlbumID, &it.AlbumTitle,
			&it.TrackNo, &it.DurationMS, &it.Artist, &it.Aka, &it.Owned,
			&it.Source, &it.ExternalID, &it.CoverURL, &it.CreatedAt); err != nil {
			return nil, err
		}
		if s.PlayableRoots != nil && !FilePlayable(roots, path) {
			continue
		}
		out[tidalID] = it
	}
	return out, rows.Err()
}

// TrackMatchKey is what an album's library tracks are matched to TIDAL
// entries by, when no saved-copy record links them.
type TrackMatchKey struct {
	ISRC    string
	DiscNo  int
	TrackNo int
	Title   string
	// Playable is false when the file is gone or outside the enabled roots
	// (checked when PlayableRoots is set); such a track can't stand in for
	// a playable TIDAL entry.
	Playable bool
}

// AlbumTrackKeys returns the match keys of an album's tracks visible to the
// viewer.
func (s *Store) AlbumTrackKeys(ctx context.Context, albumID, viewerID uuid.UUID) (map[uuid.UUID]TrackMatchKey, error) {
	rows, err := s.db.Query(ctx, `
		SELECT t.id, COALESCE(t.isrc, ''), COALESCE(t.disc_no, 0), COALESCE(t.track_no, 0), t.title, t.file_path
		FROM tracks t
		WHERE t.album_id = $1 AND t.deleted_at IS NULL AND t.library_visible = TRUE
		  AND `+trackVisibleP2+`
		LIMIT $3`, albumID, viewerID, maxUnpagedTrackRows)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var roots []string
	if s.PlayableRoots != nil {
		roots = s.PlayableRoots(ctx)
	}
	out := map[uuid.UUID]TrackMatchKey{}
	for rows.Next() {
		var (
			id   uuid.UUID
			k    TrackMatchKey
			path string
		)
		if err := rows.Scan(&id, &k.ISRC, &k.DiscNo, &k.TrackNo, &k.Title, &path); err != nil {
			return nil, err
		}
		k.Playable = s.PlayableRoots == nil || FilePlayable(roots, path)
		out[id] = k
	}
	return out, rows.Err()
}

func cleanAll(in []string) []string {
	out := make([]string, 0, len(in))
	for _, v := range in {
		if v = strings.TrimSpace(dbtext.Clean(v)); v != "" {
			out = append(out, v)
		}
	}
	return out
}
