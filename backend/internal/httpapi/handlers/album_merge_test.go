package handlers

import (
	"testing"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/tidal"
)

func TestMergeAlbumTracksSwapsInLibraryCopies(t *testing.T) {
	release := tidal.Album{ID: "100", Title: "Record", CoverURL: "https://resources.tidal.com/images/c/640x640.jpg", Tracks: []tidal.Track{
		{ID: "1", Title: "One", TrackNo: 1, DiscNo: 1, DurationMS: 1000, Artists: []string{"Band"}},
		{ID: "2", Title: "Two", TrackNo: 2, DiscNo: 1, DurationMS: 2000, ISRC: "usabc2100002"},
		{ID: "3", Title: "Three", TrackNo: 3, DiscNo: 1, DurationMS: 3000},
		{ID: "4", Title: "Four", TrackNo: 4, DiscNo: 1, DurationMS: 4000},
	}}
	savedCopy := library.TrackListItem{ID: uuid.New(), Title: "One (saved)", Source: "local", DurationMS: 1001}
	isrcMatch := library.TrackListItem{ID: uuid.New(), Title: "Two (file)", Source: "local", DurationMS: 2001}
	positionMatch := library.TrackListItem{ID: uuid.New(), Title: "three", Source: "local", DurationMS: 3001}
	extra := library.TrackListItem{ID: uuid.New(), Title: "Bonus", Source: "local", DurationMS: 5000}
	locals := []library.TrackListItem{isrcMatch, positionMatch, extra}
	keys := map[uuid.UUID]library.TrackMatchKey{
		isrcMatch.ID:     {ISRC: "USABC2100002", TrackNo: 9, Playable: true},
		positionMatch.ID: {TrackNo: 3, Title: " Three ", Playable: true}, // disc 0 = disc 1
		extra.ID:         {TrackNo: 99, Title: "Bonus", Playable: true},
	}
	favs := map[uuid.UUID]struct{}{isrcMatch.ID: {}}

	got := mergeAlbumTracks(release, map[string]library.TrackListItem{"1": savedCopy}, locals, keys, favs, true)

	var ids []string
	for _, tr := range got.Tracks {
		ids = append(ids, tr.ID)
	}
	want := []string{
		savedCopy.ID.String(), // saved copy
		isrcMatch.ID.String(), // ISRC, despite a different number
		positionMatch.ID.String(),
		"tidal:4",         // nothing in the library
		extra.ID.String(), // unmatched library track, appended
	}
	if len(ids) != len(want) {
		t.Fatalf("tracks = %v, want %v", ids, want)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("tracks = %v, want %v", ids, want)
		}
	}
	if got.SavedCount != 4 || got.DurationMS != 1001+2001+3001+4000+5000 {
		t.Fatalf("saved %d, duration %d", got.SavedCount, got.DurationMS)
	}
	if !got.Tracks[1].Favorited || got.Tracks[0].Favorited {
		t.Fatal("favorites not carried over")
	}
	if remote := got.Tracks[3]; remote.Source != "tidal" || remote.SourceAlbumID != "100" || remote.AlbumTitle != "Record" || remote.CoverURL == "" {
		t.Fatalf("remote row = %+v", remote)
	}

	// Without appendUnmatched (one page of the TIDAL release), extras stay off.
	if paged := mergeAlbumTracks(release, nil, locals, keys, nil, false); len(paged.Tracks) != 4 {
		t.Fatalf("paged merge has %d rows, want 4", len(paged.Tracks))
	}
	// A library copy fills at most one entry.
	dup := tidal.Album{ID: "100", Tracks: []tidal.Track{{ID: "1"}, {ID: "1b", ISRC: "USABC2100002"}, {ID: "1c", ISRC: "USABC2100002"}}}
	if m := mergeAlbumTracks(dup, nil, locals, keys, nil, false); m.Tracks[1].Source != "local" || m.Tracks[2].Source != "tidal" {
		t.Fatalf("copy reused: %+v", m.Tracks)
	}
}

func TestMergeAlbumTracksSkipsUnplayableLibraryMatches(t *testing.T) {
	release := tidal.Album{ID: "100", Tracks: []tidal.Track{{ID: "1", Title: "One", TrackNo: 1, ISRC: "X1"}}}
	gone := library.TrackListItem{ID: uuid.New(), Title: "One", Source: "local"}
	keys := map[uuid.UUID]library.TrackMatchKey{gone.ID: {ISRC: "X1", TrackNo: 1, Title: "One"}} // not playable
	got := mergeAlbumTracks(release, nil, []library.TrackListItem{gone}, keys, nil, true)
	if len(got.Tracks) != 2 || got.Tracks[0].ID != "tidal:1" || got.Tracks[1].ID != gone.ID.String() {
		t.Fatalf("tracks = %+v; want the TIDAL entry, then the unplayable file listed after", got.Tracks)
	}
}
