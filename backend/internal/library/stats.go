package library

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// ReplayBucket is the granularity of the listening-activity time series.
type ReplayBucket string

const (
	BucketDay   ReplayBucket = "day"
	BucketWeek  ReplayBucket = "week"
	BucketMonth ReplayBucket = "month"
)

func (b ReplayBucket) valid() bool {
	switch b {
	case BucketDay, BucketWeek, BucketMonth:
		return true
	}
	return false
}

type ReplayHeadlineArtist struct {
	ID    uuid.UUID
	Name  string
	Plays int
}

type ReplaySummary struct {
	TotalPlays     int
	TotalMs        int64
	UniqueTracks   int
	UniqueArtists  int
	HeadlineArtist *ReplayHeadlineArtist
}

type ReplayTrack struct {
	TrackListItem
	Plays int
}

type ReplayArtist struct {
	ID    uuid.UUID
	Name  string
	Plays int
}

type ReplayAlbum struct {
	ID     uuid.UUID
	Title  string
	Artist string
	Plays  int
}

type ReplayGenreSlice struct {
	Genre string
	Plays int
}

type ReplayActivityBucket struct {
	BucketStart time.Time
	Plays       int
}

type ReplayData struct {
	Summary        ReplaySummary
	TopTracks      []ReplayTrack
	TopArtists     []ReplayArtist
	TopAlbums      []ReplayAlbum
	TopGenres      []ReplayGenreSlice
	Activity       []ReplayActivityBucket
	Bucket         ReplayBucket
	AvailableYears []int
}

// ReplayStatsParams scopes the aggregation. From/To are inclusive-exclusive;
// nil means unbounded on that side. Bucket selects the granularity for the
// activity time series; if empty, ReplayStats picks based on window length.
type ReplayStatsParams struct {
	ViewerID uuid.UUID
	From     *time.Time
	To       *time.Time
	Bucket   ReplayBucket
}

// ReplayStats produces the full Replay payload for a user and time window.
// All queries share the same play_history filter and run sequentially on the
// pool; on a single-user history table they're cheap and bounded.
func (s *Store) ReplayStats(ctx context.Context, p ReplayStatsParams) (*ReplayData, error) {
	if p.ViewerID == uuid.Nil {
		return nil, errors.New("ReplayStats: ViewerID required")
	}
	bucket := p.Bucket
	if !bucket.valid() {
		bucket = chooseBucket(p.From, p.To)
	}

	data := &ReplayData{Bucket: bucket}

	if err := s.replaySummary(ctx, p, data); err != nil {
		return nil, fmt.Errorf("summary: %w", err)
	}
	if err := s.replayTopTracks(ctx, p, data); err != nil {
		return nil, fmt.Errorf("top tracks: %w", err)
	}
	if err := s.replayTopArtists(ctx, p, data); err != nil {
		return nil, fmt.Errorf("top artists: %w", err)
	}
	if err := s.replayTopAlbums(ctx, p, data); err != nil {
		return nil, fmt.Errorf("top albums: %w", err)
	}
	if err := s.replayTopGenres(ctx, p, data); err != nil {
		return nil, fmt.Errorf("top genres: %w", err)
	}
	if err := s.replayActivity(ctx, p, bucket, data); err != nil {
		return nil, fmt.Errorf("activity: %w", err)
	}
	if err := s.replayAvailableYears(ctx, p.ViewerID, data); err != nil {
		return nil, fmt.Errorf("years: %w", err)
	}
	return data, nil
}

// chooseBucket picks a sensible bucket for a time window. Falls back to month
// for unbounded (= all-time) queries.
func chooseBucket(from, to *time.Time) ReplayBucket {
	if from == nil || to == nil {
		return BucketMonth
	}
	d := to.Sub(*from)
	switch {
	case d <= 31*24*time.Hour:
		return BucketDay
	case d <= 183*24*time.Hour:
		return BucketWeek
	default:
		return BucketMonth
	}
}

func (s *Store) replaySummary(ctx context.Context, p ReplayStatsParams, out *ReplayData) error {
	// Total plays / unique tracks / total listening time
	err := s.db.QueryRow(ctx, `
		SELECT
			COUNT(*)::int,
			COUNT(DISTINCT ph.track_id)::int,
			COALESCE(SUM((t.duration_ms)::bigint * COALESCE(ph.completion, 1.0)::numeric)::bigint, 0)
		FROM play_history ph
		JOIN tracks t ON t.id = ph.track_id AND t.deleted_at IS NULL
		    AND `+trackVisibleP1+`
		WHERE ph.user_id = $1
		  AND ($2::timestamptz IS NULL OR ph.played_at >= $2)
		  AND ($3::timestamptz IS NULL OR ph.played_at <  $3)`,
		p.ViewerID, p.From, p.To,
	).Scan(&out.Summary.TotalPlays, &out.Summary.UniqueTracks, &out.Summary.TotalMs)
	if err != nil {
		return err
	}

	// Unique primary artists across the same window
	err = s.db.QueryRow(ctx, `
		SELECT COUNT(DISTINCT ta.artist_id)::int
		FROM play_history ph
		JOIN tracks t ON t.id = ph.track_id AND t.deleted_at IS NULL
		    AND `+trackVisibleP1+`
		JOIN track_artists ta ON ta.track_id = t.id AND ta.role = 'primary'
		WHERE ph.user_id = $1
		  AND ($2::timestamptz IS NULL OR ph.played_at >= $2)
		  AND ($3::timestamptz IS NULL OR ph.played_at <  $3)`,
		p.ViewerID, p.From, p.To,
	).Scan(&out.Summary.UniqueArtists)
	if err != nil {
		return err
	}

	// Headline artist = #1 most-played primary artist (if any plays at all)
	if out.Summary.TotalPlays > 0 {
		var ha ReplayHeadlineArtist
		err = s.db.QueryRow(ctx, `
			SELECT ar.id, ar.name, COUNT(*)::int AS plays
			FROM play_history ph
			JOIN tracks t ON t.id = ph.track_id AND t.deleted_at IS NULL
			    AND `+trackVisibleP1+`
			JOIN track_artists ta ON ta.track_id = t.id AND ta.role = 'primary'
			JOIN artists ar ON ar.id = ta.artist_id
			WHERE ph.user_id = $1
			  AND ($2::timestamptz IS NULL OR ph.played_at >= $2)
			  AND ($3::timestamptz IS NULL OR ph.played_at <  $3)
			GROUP BY ar.id, ar.name
			ORDER BY plays DESC, ar.name ASC
			LIMIT 1`,
			p.ViewerID, p.From, p.To,
		).Scan(&ha.ID, &ha.Name, &ha.Plays)
		if err == nil {
			out.Summary.HeadlineArtist = &ha
		}
		// If err != nil we just leave HeadlineArtist nil — not a fatal error.
	}
	return nil
}

func (s *Store) replayTopTracks(ctx context.Context, p ReplayStatsParams, out *ReplayData) error {
	rows, err := s.db.Query(ctx, `
		WITH counts AS (
			SELECT ph.track_id, COUNT(*)::int AS plays
			FROM play_history ph
			JOIN tracks t ON t.id = ph.track_id AND t.deleted_at IS NULL
			    AND `+trackVisibleP1+`
			WHERE ph.user_id = $1
			  AND ($2::timestamptz IS NULL OR ph.played_at >= $2)
			  AND ($3::timestamptz IS NULL OR ph.played_at <  $3)
			GROUP BY ph.track_id
			ORDER BY plays DESC, ph.track_id ASC
			LIMIT 25
		)
		SELECT
			t.id, t.title, t.album_id, COALESCE(a.title, ''),
			COALESCE(t.track_no, 0), t.duration_ms,
			COALESCE(STRING_AGG(ar.name, ', ' ORDER BY ta.position) FILTER (WHERE ta.role = 'primary'), ''),
			`+akaSubquery+`,
			COALESCE(t.owner_id = $1, FALSE) AS owned,
			t.created_at,
			c.plays
		FROM counts c
		JOIN tracks t ON t.id = c.track_id
		LEFT JOIN albums a ON a.id = t.album_id
		LEFT JOIN track_artists ta ON ta.track_id = t.id
		LEFT JOIN artists ar ON ar.id = ta.artist_id
		GROUP BY t.id, a.title, c.plays
		ORDER BY c.plays DESC, t.title ASC`,
		p.ViewerID, p.From, p.To)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var it ReplayTrack
		if err := rows.Scan(&it.ID, &it.Title, &it.AlbumID, &it.AlbumTitle,
			&it.TrackNo, &it.DurationMS, &it.Artist, &it.Aka, &it.Owned, &it.CreatedAt, &it.Plays); err != nil {
			return err
		}
		out.TopTracks = append(out.TopTracks, it)
	}
	return rows.Err()
}

func (s *Store) replayTopArtists(ctx context.Context, p ReplayStatsParams, out *ReplayData) error {
	rows, err := s.db.Query(ctx, `
		SELECT ar.id, ar.name, COUNT(*)::int AS plays
		FROM play_history ph
		JOIN tracks t ON t.id = ph.track_id AND t.deleted_at IS NULL
		    AND `+trackVisibleP1+`
		JOIN track_artists ta ON ta.track_id = t.id AND ta.role = 'primary'
		JOIN artists ar ON ar.id = ta.artist_id
		WHERE ph.user_id = $1
		  AND ($2::timestamptz IS NULL OR ph.played_at >= $2)
		  AND ($3::timestamptz IS NULL OR ph.played_at <  $3)
		GROUP BY ar.id, ar.name
		ORDER BY plays DESC, ar.name ASC
		LIMIT 12`,
		p.ViewerID, p.From, p.To)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var a ReplayArtist
		if err := rows.Scan(&a.ID, &a.Name, &a.Plays); err != nil {
			return err
		}
		out.TopArtists = append(out.TopArtists, a)
	}
	return rows.Err()
}

func (s *Store) replayTopAlbums(ctx context.Context, p ReplayStatsParams, out *ReplayData) error {
	rows, err := s.db.Query(ctx, `
		SELECT al.id, al.title, COALESCE(aa.name, ''), COUNT(*)::int AS plays
		FROM play_history ph
		JOIN tracks t ON t.id = ph.track_id AND t.deleted_at IS NULL
		    AND `+trackVisibleP1+`
		JOIN albums al ON al.id = t.album_id
		LEFT JOIN artists aa ON aa.id = al.album_artist_id
		WHERE ph.user_id = $1
		  AND ($2::timestamptz IS NULL OR ph.played_at >= $2)
		  AND ($3::timestamptz IS NULL OR ph.played_at <  $3)
		GROUP BY al.id, al.title, aa.name
		ORDER BY plays DESC, al.title ASC
		LIMIT 12`,
		p.ViewerID, p.From, p.To)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var a ReplayAlbum
		if err := rows.Scan(&a.ID, &a.Title, &a.Artist, &a.Plays); err != nil {
			return err
		}
		out.TopAlbums = append(out.TopAlbums, a)
	}
	return rows.Err()
}

func (s *Store) replayTopGenres(ctx context.Context, p ReplayStatsParams, out *ReplayData) error {
	rows, err := s.db.Query(ctx, `
		SELECT t.genre, COUNT(*)::int AS plays
		FROM play_history ph
		JOIN tracks t ON t.id = ph.track_id AND t.deleted_at IS NULL
		    AND `+trackVisibleP1+`
		WHERE ph.user_id = $1
		  AND t.genre IS NOT NULL AND t.genre <> ''
		  AND ($2::timestamptz IS NULL OR ph.played_at >= $2)
		  AND ($3::timestamptz IS NULL OR ph.played_at <  $3)
		GROUP BY t.genre
		ORDER BY plays DESC, t.genre ASC
		LIMIT 8`,
		p.ViewerID, p.From, p.To)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var g ReplayGenreSlice
		if err := rows.Scan(&g.Genre, &g.Plays); err != nil {
			return err
		}
		out.TopGenres = append(out.TopGenres, g)
	}
	return rows.Err()
}

func (s *Store) replayActivity(ctx context.Context, p ReplayStatsParams, bucket ReplayBucket, out *ReplayData) error {
	rows, err := s.db.Query(ctx, `
		SELECT date_trunc($4, ph.played_at) AS bucket_start, COUNT(*)::int AS plays
		FROM play_history ph
		JOIN tracks t ON t.id = ph.track_id AND t.deleted_at IS NULL
		    AND `+trackVisibleP1+`
		WHERE ph.user_id = $1
		  AND ($2::timestamptz IS NULL OR ph.played_at >= $2)
		  AND ($3::timestamptz IS NULL OR ph.played_at <  $3)
		GROUP BY bucket_start
		ORDER BY bucket_start ASC`,
		p.ViewerID, p.From, p.To, string(bucket))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var b ReplayActivityBucket
		if err := rows.Scan(&b.BucketStart, &b.Plays); err != nil {
			return err
		}
		out.Activity = append(out.Activity, b)
	}
	return rows.Err()
}

func (s *Store) replayAvailableYears(ctx context.Context, viewerID uuid.UUID, out *ReplayData) error {
	rows, err := s.db.Query(ctx, `
		SELECT DISTINCT EXTRACT(YEAR FROM ph.played_at)::int AS y
		FROM play_history ph
		WHERE ph.user_id = $1
		ORDER BY y DESC`, viewerID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var y int
		if err := rows.Scan(&y); err != nil {
			return err
		}
		out.AvailableYears = append(out.AvailableYears, y)
	}
	return rows.Err()
}

// ReplayTopTrackIDs returns just the top-N track IDs for the window, used by
// the "Generate playlist" endpoint. Ordered the same way as ReplayStats top
// tracks (plays DESC, then track id ASC for stability).
func (s *Store) ReplayTopTrackIDs(ctx context.Context, p ReplayStatsParams, limit int) ([]uuid.UUID, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	rows, err := s.db.Query(ctx, `
		SELECT ph.track_id
		FROM play_history ph
		JOIN tracks t ON t.id = ph.track_id AND t.deleted_at IS NULL
		    AND `+trackVisibleP1+`
		WHERE ph.user_id = $1
		  AND ($2::timestamptz IS NULL OR ph.played_at >= $2)
		  AND ($3::timestamptz IS NULL OR ph.played_at <  $3)
		GROUP BY ph.track_id
		ORDER BY COUNT(*) DESC, ph.track_id ASC
		LIMIT $4`,
		p.ViewerID, p.From, p.To, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]uuid.UUID, 0, limit)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
