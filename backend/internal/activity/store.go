package activity

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Activity struct {
	UserID      uuid.UUID
	DeviceID    string
	DeviceName  string
	TrackID     string
	Title       string
	Artist      string
	Album       string
	AlbumID     string
	CoverURL    string
	DurationSec int
	PositionSec int
	IsPlaying   bool
	UpdatedAt   time.Time
}

type UpsertInput struct {
	UserID      uuid.UUID
	DeviceID    string
	DeviceName  string
	TrackID     string
	Title       string
	Artist      string
	Album       string
	AlbumID     string
	CoverURL    string
	DurationSec int
	PositionSec int
	IsPlaying   bool
}

type Store struct {
	db *pgxpool.Pool
}

func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db} }

func (s *Store) Upsert(ctx context.Context, in UpsertInput) (*Activity, error) {
	in.DeviceID = clean(in.DeviceID)
	in.DeviceName = clean(in.DeviceName)
	in.TrackID = clean(in.TrackID)
	in.Title = clean(in.Title)
	in.Artist = clean(in.Artist)
	in.Album = clean(in.Album)
	in.AlbumID = clean(in.AlbumID)
	in.CoverURL = clean(in.CoverURL)
	if in.DeviceID == "" {
		return nil, errors.New("device_id required")
	}
	if in.TrackID == "" {
		return nil, errors.New("track_id required")
	}
	if in.Title == "" {
		return nil, errors.New("title required")
	}
	if in.PositionSec < 0 {
		in.PositionSec = 0
	}
	if in.DurationSec < 0 {
		in.DurationSec = 0
	}

	var out Activity
	err := s.db.QueryRow(ctx, `
		INSERT INTO playback_activity (
			user_id, device_id, device_name, track_id, title, artist, album,
			album_id, cover_url, duration_sec, position_sec, is_playing, updated_at
		) VALUES (
			$1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''),
			NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, 0), $11, $12, NOW()
		)
		ON CONFLICT (user_id, device_id) DO UPDATE SET
			device_name = EXCLUDED.device_name,
			track_id = EXCLUDED.track_id,
			title = EXCLUDED.title,
			artist = EXCLUDED.artist,
			album = EXCLUDED.album,
			album_id = EXCLUDED.album_id,
			cover_url = EXCLUDED.cover_url,
			duration_sec = EXCLUDED.duration_sec,
			position_sec = EXCLUDED.position_sec,
			is_playing = EXCLUDED.is_playing,
			updated_at = NOW()
		RETURNING
			user_id, device_id, device_name, track_id, title,
			COALESCE(artist, ''), COALESCE(album, ''), COALESCE(album_id, ''),
			COALESCE(cover_url, ''), COALESCE(duration_sec, 0), position_sec,
			is_playing, updated_at`,
		in.UserID, in.DeviceID, in.DeviceName, in.TrackID, in.Title, in.Artist,
		in.Album, in.AlbumID, in.CoverURL, in.DurationSec, in.PositionSec,
		in.IsPlaying,
	).Scan(
		&out.UserID, &out.DeviceID, &out.DeviceName, &out.TrackID, &out.Title,
		&out.Artist, &out.Album, &out.AlbumID, &out.CoverURL,
		&out.DurationSec, &out.PositionSec, &out.IsPlaying, &out.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *Store) Current(ctx context.Context, userID uuid.UUID, excludeDeviceID string, maxAge time.Duration) (*Activity, error) {
	excludeDeviceID = clean(excludeDeviceID)
	cutoff := time.Now().Add(-maxAge)
	var out Activity
	err := s.db.QueryRow(ctx, `
		SELECT
			user_id, device_id, device_name, track_id, title,
			COALESCE(artist, ''), COALESCE(album, ''), COALESCE(album_id, ''),
			COALESCE(cover_url, ''), COALESCE(duration_sec, 0), position_sec,
			is_playing, updated_at
		FROM playback_activity
		WHERE user_id = $1
		  AND updated_at >= $2
		  AND ($3 = '' OR device_id <> $3)
		ORDER BY is_playing DESC, updated_at DESC
		LIMIT 1`, userID, cutoff, excludeDeviceID,
	).Scan(
		&out.UserID, &out.DeviceID, &out.DeviceName, &out.TrackID, &out.Title,
		&out.Artist, &out.Album, &out.AlbumID, &out.CoverURL,
		&out.DurationSec, &out.PositionSec, &out.IsPlaying, &out.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &out, nil
}

func (s *Store) Delete(ctx context.Context, userID uuid.UUID, deviceID string) error {
	deviceID = clean(deviceID)
	if deviceID == "" {
		return nil
	}
	_, err := s.db.Exec(ctx, `
		DELETE FROM playback_activity
		WHERE user_id = $1 AND device_id = $2`, userID, deviceID)
	return err
}

func clean(s string) string {
	return strings.TrimSpace(s)
}
