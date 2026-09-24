package library

import (
	"reflect"
	"testing"
)

func TestMergeCachedReleaseKeepsRemovedTracks(t *testing.T) {
	old := cachedRelease{
		Title: "Record", Artist: "Band", Artists: []string{"Band", "Guest"}, ReleaseYear: 2020,
		CoverURL: "old-cover", DurationMS: 10,
		Tracks: []cachedTIDALTrack{
			{ID: "1", Title: "One", TrackNo: 1, ISRC: "X1", Artists: []string{"Band"}, DurationMS: 100},
			{ID: "2", Title: "Two", TrackNo: 2, ISRC: "X2"},
			{ID: "3", Title: "Three", TrackNo: 3, Removed: true}, // removed before, listed again now
			{ID: "4", Title: "Four", TrackNo: 4},
			{ID: "b", Title: "Bonus", TrackNo: 1, DiscNo: 2},
			{ID: "u", Title: "Unnumbered"},
		},
	}
	// TIDAL now lists 1, 3 and 4 only, and returns no artists or year; track
	// 1 comes back without its ISRC, artists and duration.
	fresh := cachedRelease{
		Title: "Record (Remastered)", CoverURL: "new-cover",
		Tracks: []cachedTIDALTrack{
			{ID: "1", Title: "One", TrackNo: 1},
			{ID: "3", Title: "Three", TrackNo: 3},
			{ID: "4", Title: "Four", TrackNo: 4},
		},
	}
	got := mergeCachedRelease(old, fresh)

	if got.Title != "Record (Remastered)" || got.CoverURL != "new-cover" || got.Artist != "Band" ||
		!reflect.DeepEqual(got.Artists, []string{"Band", "Guest"}) || got.ReleaseYear != 2020 || got.DurationMS != 10 {
		t.Fatalf("album fields = %+v", got)
	}
	var order []string
	removed := map[string]bool{}
	for _, tr := range got.Tracks {
		order = append(order, tr.ID)
		removed[tr.ID] = tr.Removed
	}
	if want := []string{"1", "2", "3", "4", "b", "u"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
	if !removed["2"] || !removed["b"] || !removed["u"] || removed["1"] || removed["3"] || removed["4"] {
		t.Fatalf("removed = %v", removed)
	}
	if got.Tracks[1].ISRC != "X2" {
		t.Fatal("a removed track lost its metadata")
	}
	if one := got.Tracks[0]; one.ISRC != "X1" || len(one.Artists) != 1 || one.DurationMS != 100 {
		t.Fatalf("a listed track lost fields the refresh omitted: %+v", one)
	}
}
