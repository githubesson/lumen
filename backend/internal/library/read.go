package library

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type TrackDetail struct {
	ID           uuid.UUID
	Title        string
	AlbumID      *uuid.UUID
	AlbumTitle   string
	TrackNo      int
	DiscNo       int
	DurationMS   int
	Genre        string
	Year         int
	Format       string
	Bitrate      int
	SampleRate   int
	Channels     int
	FilePath     string
	FileSize     int64
	Source       string
	ExternalID   string
	CoverURL     string
	Artists      []TrackArtist
	Aliases      []TrackAlias
	CoverArtPath string
	CreatedAt    time.Time
}

type TrackArtist struct {
	ID   uuid.UUID
	Name string
	Role string
}

// TrackAlias is alternate metadata captured from a file that was deduplicated
// into an existing track. It is retained for admin/internal use only; normal
// read endpoints deliberately do not populate or serialize it.
type TrackAlias struct {
	FilePath    string
	Title       string
	ArtistNames string
	AlbumTitle  string
}

// trackDetailSelect is the shared single-track projection used by GetTrack and
// GetTrackPublic; the two differ only in whether the viewer-visibility
// predicate is appended.
const trackDetailSelect = `
	SELECT
		t.id, t.title, t.album_id,
		a.title, a.cover_art_path,
		COALESCE(t.track_no, 0), COALESCE(t.disc_no, 0),
		t.duration_ms,
		COALESCE(t.genre, ''), COALESCE(t.year, 0),
		t.format,
		COALESCE(t.bitrate, 0), COALESCE(t.sample_rate, 0), COALESCE(t.channels, 0),
		t.file_path, t.file_size,
		t.source, t.external_id, COALESCE(t.external_meta->>'cover_url', ''),
		t.created_at
	FROM tracks t
	LEFT JOIN albums a ON a.id = t.album_id
	WHERE t.id = $1 AND t.deleted_at IS NULL`

// GetTrack returns the full metadata for a single track by id, including
// joined artists and album info. Returns ErrNotFound if missing, soft-deleted,
// or not visible to viewerID (not global and not owned by viewerID).
func (s *Store) GetTrack(ctx context.Context, id, viewerID uuid.UUID) (*TrackDetail, error) {
	return s.getTrackDetail(ctx, trackDetailSelect+` AND `+trackVisibleP2, id, viewerID)
}

// GetTrackPublic returns the full metadata for a single track without the
// per-viewer owner filter — callers gate access via some other mechanism
// (today: the HMAC signature on a share URL). Skips the favorite join.
func (s *Store) GetTrackPublic(ctx context.Context, id uuid.UUID) (*TrackDetail, error) {
	return s.getTrackDetail(ctx, trackDetailSelect, id)
}

// getTrackDetail runs a trackDetailSelect-shaped query (args[0] must be the
// track id) and hydrates the joined artist rows.
func (s *Store) getTrackDetail(ctx context.Context, query string, args ...any) (*TrackDetail, error) {
	t := &TrackDetail{}
	var (
		albumID  *uuid.UUID
		albTitle *string
		coverPth *string
	)
	err := s.db.QueryRow(ctx, query, args...).Scan(
		&t.ID, &t.Title, &albumID,
		&albTitle, &coverPth,
		&t.TrackNo, &t.DiscNo,
		&t.DurationMS,
		&t.Genre, &t.Year,
		&t.Format,
		&t.Bitrate, &t.SampleRate, &t.Channels,
		&t.FilePath, &t.FileSize,
		&t.Source, &t.ExternalID, &t.CoverURL,
		&t.CreatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	t.AlbumID = albumID
	if albTitle != nil {
		t.AlbumTitle = *albTitle
	}
	if coverPth != nil {
		t.CoverArtPath = *coverPth
	}
	rows, err := s.db.Query(ctx, `
		SELECT ar.id, ar.name, ta.role
		FROM track_artists ta
		JOIN artists ar ON ar.id = ta.artist_id
		WHERE ta.track_id = $1
		ORDER BY ta.position ASC`, args[0])
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ta TrackArtist
		if err := rows.Scan(&ta.ID, &ta.Name, &ta.Role); err != nil {
			return nil, err
		}
		t.Artists = append(t.Artists, ta)
	}
	return t, rows.Err()
}

// AlbumCoverPath looks up just the cover art path for an album.
func (s *Store) AlbumCoverPath(ctx context.Context, albumID uuid.UUID) (string, error) {
	var p *string
	err := s.db.QueryRow(ctx, `SELECT cover_art_path FROM albums WHERE id = $1`, albumID).Scan(&p)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	if p == nil {
		return "", ErrNotFound
	}
	return *p, nil
}

// AlbumCoverPathForViewer looks up cover art only when the album has at least
// one track visible to viewerID. Use this for authenticated cover routes.
func (s *Store) AlbumCoverPathForViewer(ctx context.Context, albumID, viewerID uuid.UUID) (string, error) {
	var p *string
	err := s.db.QueryRow(ctx, `
		SELECT a.cover_art_path
		FROM albums a
		WHERE a.id = $1
		  AND EXISTS (
		    SELECT 1
		    FROM tracks t
		    WHERE t.album_id = a.id
		      AND t.deleted_at IS NULL
		      AND t.library_visible = TRUE
		      AND `+trackVisibleP2+`
		  )`, albumID, viewerID).Scan(&p)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	if p == nil || *p == "" {
		return "", ErrNotFound
	}
	return *p, nil
}

type RemoteCover struct {
	Source   string
	CoverID  string
	CoverURL string
}

// RemoteAlbumCoverForViewer returns remote artwork for a hidden streamed album
// when the viewer has encountered one of its tracks through a playlist,
// favorite, or play history. Local album covers are handled by
// AlbumCoverPathForViewer; this is the passthrough fallback for sources like
// TIDAL that store artwork URLs in track external metadata.
func (s *Store) RemoteAlbumCoverForViewer(ctx context.Context, albumID, viewerID uuid.UUID) (RemoteCover, error) {
	var c RemoteCover
	err := s.db.QueryRow(ctx, `
		SELECT
			t.source,
			COALESCE(t.external_meta->>'cover_id', ''),
			COALESCE(t.external_meta->>'cover_url', '')
		FROM tracks t
		WHERE t.album_id = $1
		  AND t.deleted_at IS NULL
		  AND t.source <> 'local'
		  AND (
		    COALESCE(t.external_meta->>'cover_id', '') <> ''
		    OR COALESCE(t.external_meta->>'cover_url', '') <> ''
		  )
		  AND (
		    EXISTS (
		      SELECT 1
		      FROM playlist_tracks pt
		      JOIN playlists p ON p.id = pt.playlist_id
		      LEFT JOIN playlist_collaborators pc
		        ON pc.playlist_id = p.id
		       AND pc.user_id = $2
		       AND pc.status = 'accepted'
		       AND p.visibility = 'collaborative'
		      WHERE pt.track_id = t.id
		        AND (p.owner_id = $2 OR pc.user_id IS NOT NULL)
		    )
		    OR EXISTS (
		      SELECT 1 FROM user_track_stats uts
		      WHERE uts.track_id = t.id AND uts.user_id = $2
		    )
		    OR EXISTS (
		      SELECT 1 FROM play_history ph
		      WHERE ph.track_id = t.id AND ph.user_id = $2
		    )
		  )
		ORDER BY
			(COALESCE(t.external_meta->>'cover_id', '') <> '') DESC,
			t.created_at DESC
		LIMIT 1`, albumID, viewerID).Scan(&c.Source, &c.CoverID, &c.CoverURL)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return RemoteCover{}, ErrNotFound
		}
		return RemoteCover{}, err
	}
	return c, nil
}

type TrackListItem struct {
	ID         uuid.UUID
	Title      string
	AlbumID    *uuid.UUID
	AlbumTitle string
	TrackNo    int
	DurationMS int
	Artist     string // primary artist, comma-joined for display
	Aka        string // " • "-joined distinct alternate titles from track_aliases; empty when none
	CreatedAt  time.Time
	Owned      bool // true when the track is the viewer's own personal upload
	Source     string
	ExternalID string
	CoverURL   string
}

type ListTracksParams struct {
	ViewerID uuid.UUID // filter to global + this user's personal tracks
	Limit    int
	Offset   int
	Query    string // optional fuzzy search (title/album/artist via pg_trgm)
}

type AlbumListItem struct {
	ID            uuid.UUID
	Title         string
	ArtistID      *uuid.UUID
	ArtistName    string
	IsCompilation bool
	ReleaseYear   int
	TrackCount    int
	DurationMS    int64
	HasCover      bool
}

type AlbumDetail struct {
	AlbumListItem
	CoverArtPath string
}

type ArtistListItem struct {
	ID         uuid.UUID
	Name       string
	TrackCount int
	AlbumCount int
}

// Album scope: a track is visible to a viewer if it is global (owner_id IS NULL)
// or owned by the viewer. An album or artist is visible if at least one such
// track exists.

// ListAlbums returns albums sorted by title with pagination + optional query.
// Only albums with at least one track visible to viewerID are included.
func (s *Store) ListAlbums(ctx context.Context, viewerID uuid.UUID, limit, offset int, query string) ([]AlbumListItem, error) {
	limit, offset = clampListPage(limit, offset, 60)
	rows, err := s.db.Query(ctx, `
		SELECT a.id, a.title, a.album_artist_id, COALESCE(aa.name, ''),
		       a.is_compilation, COALESCE(a.release_year, 0),
		       COUNT(t.id)::int, COALESCE(SUM(t.duration_ms), 0)::bigint,
		       (a.cover_art_path IS NOT NULL AND a.cover_art_path <> '') AS has_cover
		FROM albums a
		LEFT JOIN artists aa ON aa.id = a.album_artist_id
		INNER JOIN tracks t ON t.album_id = a.id
		    AND t.deleted_at IS NULL
		    AND t.library_visible = TRUE
		    AND `+trackVisibleP1+`
		WHERE $2 = '' OR a.title ILIKE '%' || $2 || '%' OR aa.name ILIKE '%' || $2 || '%'
		GROUP BY a.id, aa.name
		ORDER BY a.title ASC, a.id ASC
		LIMIT $3 OFFSET $4`,
		viewerID, query, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]AlbumListItem, 0, limit)
	for rows.Next() {
		var a AlbumListItem
		if err := rows.Scan(&a.ID, &a.Title, &a.ArtistID, &a.ArtistName,
			&a.IsCompilation, &a.ReleaseYear, &a.TrackCount, &a.DurationMS, &a.HasCover); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// CountAlbums returns the total number of albums matching the same filter as
// ListAlbums.
func (s *Store) CountAlbums(ctx context.Context, viewerID uuid.UUID, query string) (int64, error) {
	var total int64
	err := s.db.QueryRow(ctx, `
		SELECT COUNT(*) FROM (
			SELECT a.id
			FROM albums a
			LEFT JOIN artists aa ON aa.id = a.album_artist_id
			INNER JOIN tracks t ON t.album_id = a.id
			    AND t.deleted_at IS NULL
			    AND t.library_visible = TRUE
			    AND `+trackVisibleP1+`
			WHERE $2 = '' OR a.title ILIKE '%' || $2 || '%' OR aa.name ILIKE '%' || $2 || '%'
			GROUP BY a.id
		) _`, viewerID, query).Scan(&total)
	return total, err
}

// GetAlbum returns a single album with aggregate info if it has any tracks
// visible to viewerID.
func (s *Store) GetAlbum(ctx context.Context, albumID, viewerID uuid.UUID) (*AlbumDetail, error) {
	var a AlbumDetail
	var cover *string
	err := s.db.QueryRow(ctx, `
		SELECT a.id, a.title, a.album_artist_id, COALESCE(aa.name, ''),
		       a.is_compilation, COALESCE(a.release_year, 0),
		       COUNT(t.id)::int, COALESCE(SUM(t.duration_ms), 0)::bigint,
		       (a.cover_art_path IS NOT NULL AND a.cover_art_path <> '') AS has_cover,
		       a.cover_art_path
		FROM albums a
		LEFT JOIN artists aa ON aa.id = a.album_artist_id
		INNER JOIN tracks t ON t.album_id = a.id
		    AND t.deleted_at IS NULL
		    AND t.library_visible = TRUE
		    AND `+trackVisibleP2+`
		WHERE a.id = $1
		GROUP BY a.id, aa.name`, albumID, viewerID).
		Scan(&a.ID, &a.Title, &a.ArtistID, &a.ArtistName,
			&a.IsCompilation, &a.ReleaseYear, &a.TrackCount, &a.DurationMS, &a.HasCover, &cover)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if cover != nil {
		a.CoverArtPath = *cover
	}
	return &a, nil
}

// ListAlbumTracks returns every track on an album that the viewer can see,
// sorted by disc/track number.
func (s *Store) ListAlbumTracks(ctx context.Context, albumID, viewerID uuid.UUID) ([]TrackListItem, error) {
	rows, err := s.db.Query(ctx, `
		SELECT
			t.id, t.title, t.album_id, COALESCE(a.title, ''),
			COALESCE(t.track_no, 0), t.duration_ms,
			COALESCE(STRING_AGG(ar.name, ', ' ORDER BY ta.position) FILTER (WHERE ta.role = 'primary'), ''),
			`+akaSubquery+`,
			COALESCE(t.owner_id = $2, FALSE) AS owned,
			t.source, t.external_id, COALESCE(t.external_meta->>'cover_url', ''),
			t.created_at
		FROM tracks t
		LEFT JOIN albums a ON a.id = t.album_id
		LEFT JOIN track_artists ta ON ta.track_id = t.id
		LEFT JOIN artists ar ON ar.id = ta.artist_id
		WHERE t.album_id = $1 AND t.deleted_at IS NULL
		  AND t.library_visible = TRUE
		  AND `+trackVisibleP2+`
		GROUP BY t.id, a.title
		ORDER BY COALESCE(t.disc_no, 0) ASC, COALESCE(t.track_no, 0) ASC, t.title ASC`,
		albumID, viewerID)
	if err != nil {
		return nil, err
	}
	return scanTrackListItems(rows, 0)
}

// trackVisibleP1 and trackVisibleP2 are the viewer-visibility predicate — the
// sole in-DB gate that stops one user from reading another user's private
// uploads. A track row is visible when it is global (owner_id IS NULL) or owned
// by the viewer. The suffix names the positional placeholder the viewer's id is
// bound to ($1 or $2) in the surrounding query.
//
// This invariant was previously copy-pasted inline ~26 times across read.go,
// stats.go and playlists. Keeping it in exactly one place makes it greppable
// and means a schema/rule change (or a forgotten copy) can't silently open a
// cross-user leak. Concatenating these consts back into each query reproduces
// the identical SQL text the literals produced before.
const (
	trackVisibleP1 = "(t.owner_id IS NULL OR t.owner_id = $1)"
	trackVisibleP2 = "(t.owner_id IS NULL OR t.owner_id = $2)"
)

// clampListPage applies the standard list-pagination bounds shared by the
// paginated list endpoints: a non-positive limit falls back to def, the limit
// is capped at 500, and a negative offset is floored at 0.
func clampListPage(limit, offset, def int) (int, int) {
	if limit <= 0 {
		limit = def
	}
	if limit > 500 {
		limit = 500
	}
	if offset < 0 {
		offset = 0
	}
	return limit, offset
}

// akaSubquery aggregates alternate titles from track_aliases into a single
// display string for a track list row. Kept as a package-level constant so
// the SQL stays in one place even though it's inlined into several queries.
const akaSubquery = `
	COALESCE(
		(SELECT STRING_AGG(DISTINCT al.title, ' • ')
		 FROM track_aliases al
		 WHERE al.track_id = t.id
		   AND al.title IS NOT NULL
		   AND al.title <> t.title),
		''
	)`

// trackSearchFilter is the substring search filter shared by ListTracks and
// CountTracks: it matches the query (bound to $2) against the track title,
// album title, any artist name, or any captured alias metadata. The two
// queries must stay in lockstep so a paginated list and its total agree.
const trackSearchFilter = `
		  AND (
			t.title ILIKE '%' || $2 || '%'
			OR a.title ILIKE '%' || $2 || '%'
			OR ar.name ILIKE '%' || $2 || '%'
			OR EXISTS (
			  SELECT 1 FROM track_aliases al
			  WHERE al.track_id = t.id
			    AND (
			      al.title ILIKE '%' || $2 || '%'
			      OR al.artist_names ILIKE '%' || $2 || '%'
			      OR al.album_title ILIKE '%' || $2 || '%'
			      OR al.file_path ILIKE '%' || $2 || '%'
			    )
			)
		  )`

// scanTrackListItems drains rows whose projection matches the standard
// TrackListItem column order (id, title, album_id, album_title, track_no,
// duration_ms, artist, aka, owned, source, external_id, cover_url, timestamp)
// shared by the track list
// queries. It closes rows and always returns a non-nil slice on success.
func scanTrackListItems(rows pgx.Rows, capHint int) ([]TrackListItem, error) {
	defer rows.Close()
	out := make([]TrackListItem, 0, capHint)
	for rows.Next() {
		var it TrackListItem
		if err := rows.Scan(&it.ID, &it.Title, &it.AlbumID, &it.AlbumTitle,
			&it.TrackNo, &it.DurationMS, &it.Artist, &it.Aka, &it.Owned,
			&it.Source, &it.ExternalID, &it.CoverURL, &it.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// ListArtists returns artists with track/album counts, paginated + optional
// name search. Only artists with at least one visible track are included.
func (s *Store) ListArtists(ctx context.Context, viewerID uuid.UUID, limit, offset int, query string) ([]ArtistListItem, error) {
	limit, offset = clampListPage(limit, offset, 60)
	rows, err := s.db.Query(ctx, `
		SELECT ar.id, ar.name,
		       COUNT(DISTINCT t.id)::int AS track_count,
		       COUNT(DISTINCT t.album_id) FILTER (WHERE t.album_id IS NOT NULL)::int AS album_count
		FROM artists ar
		INNER JOIN track_artists ta ON ta.artist_id = ar.id
		INNER JOIN tracks t ON t.id = ta.track_id
		    AND t.deleted_at IS NULL
		    AND t.library_visible = TRUE
		    AND `+trackVisibleP1+`
		WHERE $2 = '' OR ar.name ILIKE '%' || $2 || '%'
		GROUP BY ar.id
		ORDER BY LOWER(ar.name) ASC, ar.id ASC
		LIMIT $3 OFFSET $4`,
		viewerID, query, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ArtistListItem, 0, limit)
	for rows.Next() {
		var a ArtistListItem
		if err := rows.Scan(&a.ID, &a.Name, &a.TrackCount, &a.AlbumCount); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// CountArtists matches ListArtists.
func (s *Store) CountArtists(ctx context.Context, viewerID uuid.UUID, query string) (int64, error) {
	var total int64
	err := s.db.QueryRow(ctx, `
		SELECT COUNT(*) FROM (
			SELECT ar.id
			FROM artists ar
			INNER JOIN track_artists ta ON ta.artist_id = ar.id
			INNER JOIN tracks t ON t.id = ta.track_id
			    AND t.deleted_at IS NULL
			    AND t.library_visible = TRUE
			    AND `+trackVisibleP1+`
			WHERE $2 = '' OR ar.name ILIKE '%' || $2 || '%'
			GROUP BY ar.id
		) _`, viewerID, query).Scan(&total)
	return total, err
}

// GetArtist returns a single artist if they have at least one visible track.
func (s *Store) GetArtist(ctx context.Context, artistID, viewerID uuid.UUID) (*ArtistListItem, error) {
	var a ArtistListItem
	err := s.db.QueryRow(ctx, `
		SELECT ar.id, ar.name,
		       COUNT(DISTINCT t.id)::int,
		       COUNT(DISTINCT t.album_id) FILTER (WHERE t.album_id IS NOT NULL)::int
		FROM artists ar
		INNER JOIN track_artists ta ON ta.artist_id = ar.id
		INNER JOIN tracks t ON t.id = ta.track_id
		    AND t.deleted_at IS NULL
		    AND t.library_visible = TRUE
		    AND `+trackVisibleP2+`
		WHERE ar.id = $1
		GROUP BY ar.id`, artistID, viewerID).
		Scan(&a.ID, &a.Name, &a.TrackCount, &a.AlbumCount)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &a, nil
}

// ListArtistTracks returns every visible track where the artist appears (any
// role), sorted by album then disc/track number.
func (s *Store) ListArtistTracks(ctx context.Context, artistID, viewerID uuid.UUID) ([]TrackListItem, error) {
	rows, err := s.db.Query(ctx, `
		SELECT
			t.id, t.title, t.album_id, COALESCE(a.title, ''),
			COALESCE(t.track_no, 0), t.duration_ms,
			COALESCE(STRING_AGG(ar2.name, ', ' ORDER BY ta2.position) FILTER (WHERE ta2.role = 'primary'), ''),
			`+akaSubquery+`,
			COALESCE(t.owner_id = $2, FALSE) AS owned,
			t.source, t.external_id, COALESCE(t.external_meta->>'cover_url', ''),
			t.created_at
		FROM tracks t
		INNER JOIN track_artists ta_filter
		    ON ta_filter.track_id = t.id AND ta_filter.artist_id = $1
		LEFT JOIN albums a ON a.id = t.album_id
		LEFT JOIN track_artists ta2 ON ta2.track_id = t.id
		LEFT JOIN artists ar2 ON ar2.id = ta2.artist_id
		WHERE t.deleted_at IS NULL
		  AND t.library_visible = TRUE
		  AND `+trackVisibleP2+`
		GROUP BY t.id, a.title
		ORDER BY (a.title IS NULL), a.title ASC,
		         COALESCE(t.disc_no, 0) ASC, COALESCE(t.track_no, 0) ASC, t.title ASC`,
		artistID, viewerID)
	if err != nil {
		return nil, err
	}
	return scanTrackListItems(rows, 0)
}

// CountTracks returns the total number of tracks visible to ViewerID under
// the same filter rules as ListTracks. Paired with ListTracks so callers can
// paginate and still know the total.
func (s *Store) CountTracks(ctx context.Context, viewerID uuid.UUID, query string) (int64, error) {
	var total int64
	if query != "" {
		err := s.db.QueryRow(ctx, `
			SELECT COUNT(DISTINCT t.id)
			FROM tracks t
			LEFT JOIN albums a ON a.id = t.album_id
			LEFT JOIN track_artists ta ON ta.track_id = t.id
			LEFT JOIN artists ar ON ar.id = ta.artist_id
			WHERE t.deleted_at IS NULL
			  AND t.library_visible = TRUE
			  AND `+trackVisibleP1+trackSearchFilter, viewerID, query).Scan(&total)
		return total, err
	}
	err := s.db.QueryRow(ctx, `
		SELECT COUNT(*) FROM tracks t
		WHERE t.deleted_at IS NULL
		  AND t.library_visible = TRUE
		  AND `+trackVisibleP1+``, viewerID).Scan(&total)
	return total, err
}

// ListTracks returns a paginated list of tracks visible to ViewerID, most
// recently added first. When Query is non-empty, filters by substring match
// against title, album title, or any artist name.
func (s *Store) ListTracks(ctx context.Context, p ListTracksParams) ([]TrackListItem, error) {
	if p.Limit <= 0 {
		p.Limit = 100
	}
	if p.Limit > 500 {
		p.Limit = 500
	}
	if p.Offset < 0 {
		p.Offset = 0
	}
	var (
		rows pgx.Rows
		err  error
	)
	if p.Query != "" {
		rows, err = s.db.Query(ctx, `
			SELECT
				t.id, t.title, t.album_id, COALESCE(a.title, ''),
				COALESCE(t.track_no, 0), t.duration_ms,
				COALESCE(STRING_AGG(ar.name, ', ' ORDER BY ta.position) FILTER (WHERE ta.role = 'primary'), ''),
				`+akaSubquery+`,
				COALESCE(t.owner_id = $1, FALSE) AS owned,
				t.source, t.external_id, COALESCE(t.external_meta->>'cover_url', ''),
				t.created_at
			FROM tracks t
			LEFT JOIN albums a ON a.id = t.album_id
			LEFT JOIN track_artists ta ON ta.track_id = t.id
			LEFT JOIN artists ar ON ar.id = ta.artist_id
			WHERE t.deleted_at IS NULL
			  AND t.library_visible = TRUE
			  AND `+trackVisibleP1+trackSearchFilter+`
			GROUP BY t.id, a.title
			ORDER BY t.created_at DESC
			LIMIT $3 OFFSET $4`, p.ViewerID, p.Query, p.Limit, p.Offset)
	} else {
		rows, err = s.db.Query(ctx, `
			SELECT
				t.id, t.title, t.album_id, COALESCE(a.title, ''),
				COALESCE(t.track_no, 0), t.duration_ms,
				COALESCE(STRING_AGG(ar.name, ', ' ORDER BY ta.position) FILTER (WHERE ta.role = 'primary'), ''),
				`+akaSubquery+`,
				COALESCE(t.owner_id = $1, FALSE) AS owned,
				t.source, t.external_id, COALESCE(t.external_meta->>'cover_url', ''),
				t.created_at
			FROM tracks t
			LEFT JOIN albums a ON a.id = t.album_id
			LEFT JOIN track_artists ta ON ta.track_id = t.id
			LEFT JOIN artists ar ON ar.id = ta.artist_id
			WHERE t.deleted_at IS NULL
			  AND t.library_visible = TRUE
			  AND `+trackVisibleP1+`
			GROUP BY t.id, a.title
			ORDER BY t.created_at DESC
			LIMIT $2 OFFSET $3`, p.ViewerID, p.Limit, p.Offset)
	}
	if err != nil {
		return nil, err
	}
	return scanTrackListItems(rows, p.Limit)
}

// SetFavorite toggles the favorite flag on a user_track_stats row, upserting
// the row if it doesn't exist yet.
func (s *Store) SetFavorite(ctx context.Context, userID, trackID uuid.UUID, fav bool) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO user_track_stats (user_id, track_id, favorited, favorited_at)
		VALUES ($1, $2, $3, CASE WHEN $3 THEN NOW() ELSE NULL END)
		ON CONFLICT (user_id, track_id) DO UPDATE
		SET favorited = $3,
		    favorited_at = CASE WHEN $3 THEN NOW() ELSE NULL END`,
		userID, trackID, fav)
	return err
}

// ListFavorites returns the user's favorited tracks that are still visible
// to them (global or their own personal), most-recently-favorited first.
func (s *Store) ListFavorites(ctx context.Context, userID uuid.UUID, limit, offset int) ([]TrackListItem, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	if offset < 0 {
		offset = 0
	}
	rows, err := s.db.Query(ctx, `
		SELECT
			t.id, t.title, t.album_id, COALESCE(a.title, ''),
			COALESCE(t.track_no, 0), t.duration_ms,
			COALESCE(STRING_AGG(ar.name, ', ' ORDER BY ta.position) FILTER (WHERE ta.role = 'primary'), ''),
			`+akaSubquery+`,
			COALESCE(t.owner_id = $1, FALSE) AS owned,
			t.source, t.external_id, COALESCE(t.external_meta->>'cover_url', ''),
			uts.favorited_at
		FROM user_track_stats uts
		JOIN tracks t ON t.id = uts.track_id AND t.deleted_at IS NULL
		LEFT JOIN albums a ON a.id = t.album_id
		LEFT JOIN track_artists ta ON ta.track_id = t.id
		LEFT JOIN artists ar ON ar.id = ta.artist_id
		WHERE uts.user_id = $1
		  AND uts.favorited = TRUE
		  AND `+trackVisibleP1+`
		GROUP BY t.id, a.title, uts.favorited_at
		ORDER BY uts.favorited_at DESC NULLS LAST
		LIMIT $2 OFFSET $3`, userID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]TrackListItem, 0, limit)
	for rows.Next() {
		var it TrackListItem
		var favAt *time.Time
		if err := rows.Scan(&it.ID, &it.Title, &it.AlbumID, &it.AlbumTitle,
			&it.TrackNo, &it.DurationMS, &it.Artist, &it.Aka, &it.Owned,
			&it.Source, &it.ExternalID, &it.CoverURL, &favAt); err != nil {
			return nil, err
		}
		if favAt != nil {
			it.CreatedAt = *favAt
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// FavoriteIDs returns just the set of track IDs the user has favorited. Used
// to annotate list rows in bulk.
func (s *Store) FavoriteIDs(ctx context.Context, userID uuid.UUID) (map[uuid.UUID]struct{}, error) {
	rows, err := s.db.Query(ctx, `
		SELECT track_id FROM user_track_stats
		WHERE user_id = $1 AND favorited = TRUE`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[uuid.UUID]struct{}{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = struct{}{}
	}
	return out, rows.Err()
}

// ListRecent returns the user's recent play history, deduplicated so each
// track only appears at its most-recent playback time.
func (s *Store) ListRecent(ctx context.Context, userID uuid.UUID, limit int) ([]TrackListItem, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.Query(ctx, `
		WITH last_play AS (
			SELECT track_id, MAX(played_at) AS played_at
			FROM play_history
			WHERE user_id = $1
			GROUP BY track_id
		)
		SELECT
			t.id, t.title, t.album_id, COALESCE(a.title, ''),
			COALESCE(t.track_no, 0), t.duration_ms,
			COALESCE(STRING_AGG(ar.name, ', ' ORDER BY ta.position) FILTER (WHERE ta.role = 'primary'), ''),
			`+akaSubquery+`,
			COALESCE(t.owner_id = $1, FALSE) AS owned,
			t.source, t.external_id, COALESCE(t.external_meta->>'cover_url', ''),
			lp.played_at
		FROM last_play lp
		JOIN tracks t ON t.id = lp.track_id AND t.deleted_at IS NULL
		LEFT JOIN albums a ON a.id = t.album_id
		LEFT JOIN track_artists ta ON ta.track_id = t.id
		LEFT JOIN artists ar ON ar.id = ta.artist_id
		WHERE `+trackVisibleP1+`
		GROUP BY t.id, a.title, lp.played_at
		ORDER BY lp.played_at DESC
		LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	return scanTrackListItems(rows, limit)
}

// RecordPlay bumps the user's play count for a track and appends a play_history
// row. Caller is expected to gate this on a meaningful playback threshold
// (e.g. 30s or 50% of track duration).
func (s *Store) RecordPlay(ctx context.Context, userID, trackID uuid.UUID, completion float32) error {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO user_track_stats (user_id, track_id, play_count, last_played_at)
		VALUES ($1, $2, 1, NOW())
		ON CONFLICT (user_id, track_id) DO UPDATE
		SET play_count = user_track_stats.play_count + 1,
		    last_played_at = NOW()`, userID, trackID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO play_history (user_id, track_id, completion)
		VALUES ($1, $2, $3)`, userID, trackID, completion); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
