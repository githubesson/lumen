package lastfm

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/githubesson/lumen/internal/library"
	"github.com/google/uuid"
)

type Service struct {
	Client  *Client
	Store   *Store
	Library *library.Store
}

type Status struct {
	Configured bool
	Connected  bool
	Pending    bool
	Username   string
	LastError  string
}

func (s *Service) Status(ctx context.Context, userID uuid.UUID) (Status, error) {
	status := Status{Configured: s != nil && s.Client != nil && s.Client.Configured()}
	if s == nil || s.Store == nil {
		return status, nil
	}
	connection, err := s.Store.Get(ctx, userID)
	if errors.Is(err, ErrNotConnected) {
		return status, nil
	}
	if err != nil {
		return status, err
	}
	status.Connected = connection.SessionKey != ""
	status.Pending = connection.PendingToken != "" && connection.PendingUntil != nil && connection.PendingUntil.After(time.Now())
	status.Username = connection.Username
	status.LastError = connection.LastError
	return status, nil
}

func (s *Service) Begin(ctx context.Context, userID uuid.UUID) (string, error) {
	token, err := s.Client.GetToken(ctx)
	if err != nil {
		return "", err
	}
	if err := s.Store.Begin(ctx, userID, token, time.Now().Add(time.Hour)); err != nil {
		return "", err
	}
	return s.Client.AuthorizationURL(token), nil
}

func (s *Service) Complete(ctx context.Context, userID uuid.UUID) (string, error) {
	connection, err := s.Store.Get(ctx, userID)
	if err != nil {
		return "", err
	}
	// Completion is intentionally idempotent. More than one open client may be
	// polling the same pending authorization; once one wins, the others should
	// observe the established session instead of surfacing a false expiry.
	if connection.SessionKey != "" {
		return connection.Username, nil
	}
	if connection.PendingToken == "" || connection.PendingUntil == nil || !connection.PendingUntil.After(time.Now()) {
		return "", errors.New("last.fm authorization has expired")
	}
	session, err := s.Client.GetSession(ctx, connection.PendingToken)
	if err != nil {
		return "", err
	}
	if err := s.Store.Complete(ctx, userID, session); err != nil {
		return "", err
	}
	return session.Username, nil
}

func (s *Service) NowPlaying(ctx context.Context, userID, trackID uuid.UUID) error {
	connection, track, err := s.connectionAndTrack(ctx, userID, trackID)
	if err != nil {
		return err
	}
	return s.submit(ctx, userID, func() error {
		return s.Client.UpdateNowPlaying(ctx, connection.SessionKey, track)
	})
}

func (s *Service) Scrobble(
	ctx context.Context,
	userID, trackID uuid.UUID,
	startedAt time.Time,
	listenedSeconds float64,
) error {
	connection, track, err := s.connectionAndTrack(ctx, userID, trackID)
	if err != nil {
		return err
	}
	threshold := float64(track.DurationSec) / 2
	if threshold > 240 {
		threshold = 240
	}
	if track.DurationSec <= 30 || listenedSeconds < threshold {
		return ErrIneligible
	}
	track.StartedAt = startedAt
	return s.submit(ctx, userID, func() error {
		return s.Client.Scrobble(ctx, connection.SessionKey, track)
	})
}

func (s *Service) connectionAndTrack(ctx context.Context, userID, trackID uuid.UUID) (*Connection, Track, error) {
	connection, err := s.Store.Get(ctx, userID)
	if err != nil || connection.SessionKey == "" {
		return nil, Track{}, ErrNotConnected
	}
	detail, err := s.Library.GetTrack(ctx, trackID, userID)
	if err != nil {
		return nil, Track{}, err
	}
	artist := ""
	for _, candidate := range detail.Artists {
		if candidate.Role == "primary" {
			artist = candidate.Name
			break
		}
	}
	if artist == "" && len(detail.Artists) > 0 {
		artist = detail.Artists[0].Name
	}
	if strings.TrimSpace(artist) == "" || strings.TrimSpace(detail.Title) == "" {
		return nil, Track{}, errors.New("track is missing Last.fm artist or title metadata")
	}
	return connection, Track{
		Artist:      artist,
		Title:       detail.Title,
		Album:       detail.AlbumTitle,
		TrackNumber: detail.TrackNo,
		DurationSec: detail.DurationMS / 1000,
	}, nil
}

func (s *Service) submit(ctx context.Context, userID uuid.UUID, call func() error) error {
	err := call()
	if err == nil {
		_ = s.Store.SetError(ctx, userID, "")
		return nil
	}
	var apiErr *APIError
	if errors.As(err, &apiErr) && apiErr.Code == 9 {
		_ = s.Store.InvalidateSession(ctx, userID, apiErr.Error())
	} else {
		_ = s.Store.SetError(ctx, userID, err.Error())
	}
	return err
}
