package handlers

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/tidal"
	"github.com/githubesson/lumen/internal/trackref"
)

func materializeTIDALTrack(ctx context.Context, lib *library.Store, tidalClient *tidal.Client, tidalID string) (uuid.UUID, error) {
	if tidalClient == nil {
		return uuid.Nil, tidal.ErrNotConfigured
	}
	if id, err := lib.TrackIDForExternal(ctx, trackref.SourceTIDAL, tidalID); err == nil {
		return id, nil
	} else if !errors.Is(err, library.ErrNotFound) {
		return uuid.Nil, err
	}
	t, err := tidalClient.Track(ctx, tidalID)
	if err != nil {
		return uuid.Nil, err
	}
	return lib.UpsertRemoteTrack(ctx, library.RemoteTrackInput{
		Source:      trackref.SourceTIDAL,
		ExternalID:  t.ID,
		Title:       t.Title,
		ArtistNames: t.Artists,
		AlbumTitle:  t.AlbumTitle,
		AlbumArtist: t.AlbumArtist,
		DurationMS:  t.DurationMS,
		TrackNo:     t.TrackNo,
		DiscNo:      t.DiscNo,
		Year:        t.Year,
		ISRC:        t.ISRC,
		CoverID:     t.CoverID,
		CoverURL:    t.CoverURL,
		Metadata:    t.Metadata(),
	})
}

func resolveTrackRowID(ctx context.Context, lib *library.Store, tidalClient *tidal.Client, raw string, createRemote bool) (uuid.UUID, error) {
	ref, err := trackref.Parse(raw)
	if err != nil {
		return uuid.Nil, err
	}
	switch ref.Source {
	case trackref.SourceLocal:
		return ref.LocalID, nil
	case trackref.SourceTIDAL:
		if createRemote {
			return materializeTIDALTrack(ctx, lib, tidalClient, ref.ID)
		}
		return lib.TrackIDForExternal(ctx, trackref.SourceTIDAL, ref.ID)
	default:
		return uuid.Nil, errors.New("unsupported track source")
	}
}

func canonicalTrackRef(source string, localID uuid.UUID, externalID string) string {
	return trackref.Canonical(source, localID, externalID)
}

func sourceOrLocal(source string) string {
	if source == "" {
		return trackref.SourceLocal
	}
	return source
}
