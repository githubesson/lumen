package handlers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/tidal"
	"github.com/githubesson/lumen/internal/trackref"
)

var (
	// errBadTrackRef marks a track id that doesn't parse. It and
	// tidal.ErrInvalidID, for a TIDAL id TIDAL could never have issued, are
	// the resolve failures that are the caller's mistake.
	errBadTrackRef = errors.New("bad track id")
	// errTIDALLookup marks a failed TIDAL lookup of a track being
	// materialized, which is TIDAL's failure rather than the server's.
	errTIDALLookup = errors.New("tidal track lookup failed")
)

// writeTIDALUnavailable answers the TIDAL failures every endpoint reports
// alike: 503 when TIDAL isn't set up, and 502 with TIDAL's reason when it
// refused (refusedLead, see tidalRefusalText). It reports whether err was
// one of them, leaving any other error to the caller.
func writeTIDALUnavailable(w http.ResponseWriter, err error, refusedLead string) bool {
	switch {
	case errors.Is(err, tidal.ErrNotConfigured):
		http.Error(w, "tidal proxy is not configured", http.StatusServiceUnavailable)
	case errors.Is(err, tidal.ErrRefused):
		http.Error(w, tidalRefusalText(refusedLead, err), http.StatusBadGateway)
	default:
		return false
	}
	return true
}

// writeTIDALError answers a failed TIDAL lookup: writeTIDALUnavailable, and
// a 502 with fallback for any other failure.
func writeTIDALError(w http.ResponseWriter, err error, refusedLead, fallback string) {
	if !writeTIDALUnavailable(w, err, refusedLead) {
		http.Error(w, fallback, http.StatusBadGateway)
	}
}

// writeTrackResolveError answers a failure to resolve a request's track id,
// which may have looked the track up on TIDAL. As in writeStoreError, only a
// malformed id is a 400: a track that doesn't exist or that the viewer can't
// see is a 404, TIDAL failing a 502 (503 when it isn't set up), and anything
// else, such as a database error, a 500 the client can retry.
func writeTrackResolveError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errBadTrackRef), errors.Is(err, tidal.ErrInvalidID):
		http.Error(w, "bad track id", http.StatusBadRequest)
	case errors.Is(err, library.ErrNotFound):
		http.Error(w, "not found", http.StatusNotFound)
	case errors.Is(err, errTIDALLookup), errors.Is(err, tidal.ErrNotConfigured):
		writeTIDALError(w, err, "TIDAL refused this track", "tidal track lookup failed")
	default:
		if !errors.Is(err, context.Canceled) {
			slog.Error("track id resolve failed", "err", err)
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
	}
}

func materializeTIDALTrack(ctx context.Context, lib *library.Store, tidalClient *tidal.Client, tidalID string) (uuid.UUID, error) {
	// A track saved by playlist auto-download is referenced by its local copy
	// from then on, so adds, favorites, and plays all land on the same row.
	if id, err := lib.DownloadedTIDALTrack(ctx, tidalID); err == nil {
		return id, nil
	} else if !errors.Is(err, library.ErrNotFound) {
		return uuid.Nil, err
	}
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
		return uuid.Nil, fmt.Errorf("%w: %w", errTIDALLookup, err)
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

func resolveTrackRowID(ctx context.Context, lib *library.Store, tidalClient *tidal.Client, viewer uuid.UUID, raw string, createRemote bool) (uuid.UUID, error) {
	id, _, err := resolveTrackEntry(ctx, lib, tidalClient, viewer, raw, createRemote)
	return id, err
}

// resolveSongRowID is resolveTrackRowID for writes that belong to the song
// rather than to one of its files: plays, favorites, playlist entries. A
// track hidden behind a linked track (a client may still hold its id) resolves
// to that track, where the library shows the song, so the write isn't lost
// with the hidden file.
func resolveSongRowID(ctx context.Context, lib *library.Store, tidalClient *tidal.Client, viewer uuid.UUID, raw string, createRemote bool) (uuid.UUID, error) {
	id, err := resolveTrackRowID(ctx, lib, tidalClient, viewer, raw, createRemote)
	if err != nil {
		return uuid.Nil, err
	}
	return lib.ShownTrack(ctx, id)
}

// resolveTrackEntry is resolveTrackRowID that also reports the TIDAL id the
// reference stands for ("" for local tracks), which a playlist entry keeps so
// it can fall back to TIDAL if the saved copy it resolved to is deleted.
// Local ids the viewer cannot see resolve to library.ErrNotFound.
func resolveTrackEntry(ctx context.Context, lib *library.Store, tidalClient *tidal.Client, viewer uuid.UUID, raw string, createRemote bool) (uuid.UUID, string, error) {
	return resolveTrackRef(ctx, lib, tidalClient, &viewer, raw, createRemote)
}

// resolveTrackRowIDForRemoval resolves an id without the visibility check.
// Only for removing the caller's own rows (e.g. unfavorite): those touch no
// one else's data, and must keep working after the track is soft-deleted.
func resolveTrackRowIDForRemoval(ctx context.Context, lib *library.Store, tidalClient *tidal.Client, raw string) (uuid.UUID, error) {
	id, _, err := resolveTrackRef(ctx, lib, tidalClient, nil, raw, false)
	return id, err
}

// resolveTrackRef checks local ids against viewer when viewer is non-nil.
func resolveTrackRef(ctx context.Context, lib *library.Store, tidalClient *tidal.Client, viewer *uuid.UUID, raw string, createRemote bool) (uuid.UUID, string, error) {
	ref, err := trackref.Parse(raw)
	if err != nil {
		return uuid.Nil, "", fmt.Errorf("%w: %w", errBadTrackRef, err)
	}
	switch ref.Source {
	case trackref.SourceLocal:
		if viewer != nil {
			if err := lib.CheckTrackVisible(ctx, ref.LocalID, *viewer); err != nil {
				return uuid.Nil, "", err
			}
		}
		return lib.ResolveSavedTIDAL(ctx, ref.LocalID)
	case trackref.SourceTIDAL:
		var id uuid.UUID
		if createRemote {
			id, err = materializeTIDALTrack(ctx, lib, tidalClient, ref.ID)
		} else {
			id, err = lib.DownloadedTIDALTrack(ctx, ref.ID)
			if errors.Is(err, library.ErrNotFound) {
				id, err = lib.TrackIDForExternal(ctx, trackref.SourceTIDAL, ref.ID)
			}
		}
		if err != nil {
			return uuid.Nil, "", err
		}
		return id, ref.ID, nil
	default:
		return uuid.Nil, "", fmt.Errorf("%w: unsupported source %q", errBadTrackRef, ref.Source)
	}
}

func sourceOrLocal(source string) string {
	if source == "" {
		return trackref.SourceLocal
	}
	return source
}
