package library

import "testing"

func TestFullnessRanking(t *testing.T) {
	for _, tc := range []struct {
		name    string
		artists int
		album   string
		want    Fullness
	}{
		{"untagged catch-all", 0, CatchAllAlbum, Fullness{}},
		{"album only", 0, "Leaks", Fullness{HasAlbum: true}},
		{"artists only", 2, "", Fullness{HasArtists: true}},
		{"real album named like the catch-all", 1, CatchAllAlbum, Fullness{HasArtists: true, HasAlbum: true}},
		{"full", 1, "Leaks", Fullness{HasArtists: true, HasAlbum: true}},
	} {
		if got := aliasFullness(tc.artists, tc.album); got != tc.want {
			t.Errorf("%s: aliasFullness(%d, %q) = %+v, want %+v", tc.name, tc.artists, tc.album, got, tc.want)
		}
	}
	// Artists outrank an album, and ties keep the current metadata.
	none, album, artists, both := Fullness{}, Fullness{HasAlbum: true}, Fullness{HasArtists: true}, Fullness{true, true}
	for _, tc := range []struct {
		a, b Fullness
		want bool
	}{
		{album, none, true}, {artists, album, true}, {both, artists, true},
		{album, artists, false}, {both, both, false}, {none, none, false},
	} {
		if got := tc.a.Fuller(tc.b); got != tc.want {
			t.Errorf("%+v.Fuller(%+v) = %v, want %v", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestTitleCredits(t *testing.T) {
	for _, tc := range []struct {
		title, name string
		want        bool
	}{
		{"Blue Hunnids (with Luh Tyler)", "Luh Tyler", true},
		{"Song [feat. A & B]", "B", true},
		{"Song ft. A, B and C", "c", true},
		{"Song (Featuring Guest)", "guest", true},
		{"I Will Survive", "Will", false},
		{"Songs of Guest", "Guest", false},
		{"Song (with Guestlist)", "Guest", false},
	} {
		if got := titleCredits(tc.title, tc.name); got != tc.want {
			t.Errorf("titleCredits(%q, %q) = %v, want %v", tc.title, tc.name, got, tc.want)
		}
	}
}
