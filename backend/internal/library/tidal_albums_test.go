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

func TestMergeCachedReleaseKeepsReleaseFactsTheRefreshOmits(t *testing.T) {
	old := cachedRelease{Title: "Record", ReleaseDate: "2020-03-27", Copyright: "© 2020 Label"}
	got := mergeCachedRelease(old, cachedRelease{Title: "Record"})
	if got.ReleaseDate != "2020-03-27" || got.Copyright != "© 2020 Label" {
		t.Fatalf("release facts lost: %+v", got)
	}
	got = mergeCachedRelease(old, cachedRelease{Title: "Record", ReleaseDate: "2021-01-01", Copyright: "© 2021 Label"})
	if got.ReleaseDate != "2021-01-01" || got.Copyright != "© 2021 Label" {
		t.Fatalf("fresh release facts not taken: %+v", got)
	}
}

func TestMergeCachedReleaseDropsADateFromAnotherYear(t *testing.T) {
	old := cachedRelease{Title: "Record", ReleaseYear: 2019, ReleaseDate: "2019-02-01"}
	// TIDAL moves the release to 2021 with only a year.
	got := mergeCachedRelease(old, cachedRelease{Title: "Record", ReleaseYear: 2021})
	if got.ReleaseYear != 2021 || got.ReleaseDate != "" {
		t.Fatalf("year %d date %q, want 2021 and no date", got.ReleaseYear, got.ReleaseDate)
	}
	// A refresh that keeps the year keeps the stored date.
	got = mergeCachedRelease(old, cachedRelease{Title: "Record", ReleaseYear: 2019})
	if got.ReleaseDate != "2019-02-01" {
		t.Fatalf("date %q, want the stored one", got.ReleaseDate)
	}
}
