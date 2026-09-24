package handlers

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/tidal"
	"github.com/githubesson/lumen/internal/trackref"
)

// albumMerge is a TIDAL release laid over the library tracks that copy it.
type albumMerge struct {
	Tracks     []trackListItemResp
	SavedCount int // rows served from the library
	DurationMS int64
}

// mergeAlbumTracks walks a TIDAL release's track list in order and uses a
// library copy for each entry that has one: the saved copy auto-download
// recorded, else an album track with the same ISRC, else one with the same
// disc, number and title. Other entries stay TIDAL tracks. With
// appendUnmatched, library tracks that matched no entry follow at the end, so
// nothing on the library album is hidden.
func mergeAlbumTracks(
	album tidal.Album,
	saved map[string]library.TrackListItem,
	locals []library.TrackListItem,
	keys map[uuid.UUID]library.TrackMatchKey,
	favs map[uuid.UUID]struct{},
	appendUnmatched bool,
) albumMerge {
	used := map[uuid.UUID]bool{}
	byISRC := map[string]library.TrackListItem{}
	byPosition := map[string]library.TrackListItem{}
	for _, it := range locals {
		k := keys[it.ID]
		// A library track that can't play mustn't hide a TIDAL entry that
		// can (it is still listed with the unmatched tracks).
		if !k.Playable {
			continue
		}
		if isrc := strings.ToUpper(strings.TrimSpace(k.ISRC)); isrc != "" {
			if _, dup := byISRC[isrc]; !dup {
				byISRC[isrc] = it
			}
		}
		if k.TrackNo > 0 {
			pk := positionKey(k.DiscNo, k.TrackNo, k.Title)
			if _, dup := byPosition[pk]; !dup {
				byPosition[pk] = it
			}
		}
	}
	take := func(it library.TrackListItem, ok bool) (library.TrackListItem, bool) {
		if !ok || used[it.ID] {
			return library.TrackListItem{}, false
		}
		used[it.ID] = true
		return it, true
	}

	var out albumMerge
	add := func(it library.TrackListItem) {
		_, fav := favs[it.ID]
		out.Tracks = append(out.Tracks, makeTrackListItemResp(it, fav, false))
		out.SavedCount++
		out.DurationMS += int64(it.DurationMS)
	}
	for _, t := range album.Tracks {
		it, ok := take(saved[t.ID], hasKey(saved, t.ID))
		if !ok {
			isrcHit, found := byISRC[strings.ToUpper(strings.TrimSpace(t.ISRC))]
			it, ok = take(isrcHit, found && strings.TrimSpace(t.ISRC) != "")
		}
		if !ok && t.TrackNo > 0 {
			posHit, found := byPosition[positionKey(t.DiscNo, t.TrackNo, t.Title)]
			it, ok = take(posHit, found)
		}
		if ok {
			add(it)
			continue
		}
		out.Tracks = append(out.Tracks, tidalAlbumTrackResp(album, t))
		out.DurationMS += int64(t.DurationMS)
	}
	if appendUnmatched {
		for _, it := range locals {
			if !used[it.ID] {
				used[it.ID] = true
				add(it)
			}
		}
	}
	if out.Tracks == nil {
		out.Tracks = []trackListItemResp{}
	}
	return out
}

func hasKey(m map[string]library.TrackListItem, k string) bool {
	_, ok := m[k]
	return ok
}

// positionKey identifies a track by disc, number and title; a missing disc
// number means the first disc.
func positionKey(disc, track int, title string) string {
	if disc <= 0 {
		disc = 1
	}
	return strings.Join([]string{strconv.Itoa(disc), strconv.Itoa(track), strings.ToLower(strings.TrimSpace(title))}, "\x00")
}

// tidalAlbumTrackResp is one TIDAL album entry as a track list row.
func tidalAlbumTrackResp(album tidal.Album, it tidal.Track) trackListItemResp {
	return trackListItemResp{
		ID:            trackref.Remote(trackref.SourceTIDAL, it.ID),
		Source:        trackref.SourceTIDAL,
		SourceID:      it.ID,
		SourceAlbumID: firstNonEmpty(it.AlbumID, album.ID),
		Title:         it.Title,
		AlbumTitle:    firstNonEmpty(it.AlbumTitle, album.Title),
		TrackNo:       it.TrackNo,
		DurationMS:    it.DurationMS,
		Artist:        strings.Join(it.Artists, ", "),
		CoverURL:      proxyRemoteCoverURL(firstNonEmpty(it.CoverURL, album.CoverURL)),
		Unavailable:   it.Removed,
	}
}

// libraryAlbumMerge builds the merged view of a library album linked to a
// TIDAL release from the cached release. ok is false when the album isn't
// linked or the release isn't cached; callers then show the library tracks.
func libraryAlbumMerge(ctx context.Context, lib *library.Store, a *library.AlbumDetail, viewerID uuid.UUID) (albumMerge, tidal.Album, bool, error) {
	if a.TIDALAlbumID == "" {
		return albumMerge{}, tidal.Album{}, false, nil
	}
	release, _, err := lib.TIDALAlbum(ctx, a.TIDALAlbumID)
	if errors.Is(err, library.ErrNotFound) {
		return albumMerge{}, tidal.Album{}, false, nil
	}
	if err != nil {
		return albumMerge{}, tidal.Album{}, false, err
	}
	merged, err := mergeWithLibrary(ctx, lib, release, &a.ID, viewerID, true)
	if err != nil {
		return albumMerge{}, tidal.Album{}, false, err
	}
	return merged, release, true, nil
}

// mergeWithLibrary loads what mergeAlbumTracks needs: saved copies of the
// release's tracks, and the tracks of localAlbumID when given.
func mergeWithLibrary(ctx context.Context, lib *library.Store, release tidal.Album, localAlbumID *uuid.UUID, viewerID uuid.UUID, appendUnmatched bool) (albumMerge, error) {
	ids := make([]string, 0, len(release.Tracks))
	for _, t := range release.Tracks {
		ids = append(ids, t.ID)
	}
	saved, err := lib.SavedTIDALCopies(ctx, ids, viewerID)
	if err != nil {
		return albumMerge{}, err
	}
	var (
		locals []library.TrackListItem
		keys   map[uuid.UUID]library.TrackMatchKey
	)
	if localAlbumID != nil {
		if locals, err = lib.ListAlbumTracks(ctx, *localAlbumID, viewerID); err != nil {
			return albumMerge{}, err
		}
		if keys, err = lib.AlbumTrackKeys(ctx, *localAlbumID, viewerID); err != nil {
			return albumMerge{}, err
		}
	}
	favIDs := make([]uuid.UUID, 0, len(saved)+len(locals))
	for _, it := range saved {
		favIDs = append(favIDs, it.ID)
	}
	favIDs = append(favIDs, trackListIDs(locals)...)
	favs, err := lib.FavoriteIDs(ctx, viewerID, favIDs)
	if err != nil {
		return albumMerge{}, err
	}
	return mergeAlbumTracks(release, saved, locals, keys, favs, appendUnmatched), nil
}
