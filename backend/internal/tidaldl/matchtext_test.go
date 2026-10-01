package tidaldl

import (
	"testing"

	"github.com/githubesson/lumen/internal/tidal"
)

func TestMatchTitle(t *testing.T) {
	same := [][2]string{
		{"Here Comes the Sun", "Here Comes The Sun - Remastered 2009"},
		{"Something (2011 Remaster)", "Something"},
		{"Song (feat. Guest)", "Song"},
		{"Song ft. Guest", "Song [with Guest]"},
		{"Café del Mar", "Cafe Del Mar"},
		{"Rock & Roll", "Rock and Roll"},
		{"Song (Live)", "Song - Live"},
		{"Song (Skrillex Remix)", "Song - Skrillex Remix"},
		{"Song - Explicit", "Song"},
	}
	for _, p := range same {
		if a, b := matchTitle(p[0]), matchTitle(p[1]); a != b {
			t.Errorf("%q → %q and %q → %q differ", p[0], a, p[1], b)
		}
	}
	different := [][2]string{
		{"Song", "Song (Live)"},
		{"Song", "Song - Acoustic"},
		{"Song (A Remix)", "Song (B Remix)"},
		{"Song", "Song Two"},
	}
	for _, p := range different {
		if matchTitle(p[0]) == matchTitle(p[1]) {
			t.Errorf("%q and %q compare equal", p[0], p[1])
		}
	}
}

func TestMatchAlbum(t *testing.T) {
	same := [][2]string{
		{"Abbey Road", "Abbey Road (Remastered)"},
		{"Abbey Road", "Abbey Road (Super Deluxe Edition)"},
		{"OK Computer", "OK Computer (20th Anniversary Edition)"},
		{"Song", "Song - Single"},
		{"Tracks", "Tracks - EP"},
		{"Album", "Album [Bonus Track Version]"},
	}
	for _, p := range same {
		if a, b := matchAlbum(p[0]), matchAlbum(p[1]); a != b {
			t.Errorf("%q → %q and %q → %q differ", p[0], a, p[1], b)
		}
	}
	if matchAlbum("Album") == matchAlbum("Album (Live)") {
		t.Error("a live album compares equal to the studio one")
	}
}

func TestArtistsOverlap(t *testing.T) {
	for _, tc := range []struct {
		local, remote []string
		want          bool
	}{
		{[]string{"Simon", "Garfunkel"}, []string{"Simon & Garfunkel"}, true},
		{[]string{"Simon and Garfunkel"}, []string{"Simon & Garfunkel"}, true},
		{[]string{"Beyonce"}, []string{"Beyoncé", "JAY-Z"}, true},
		{[]string{"Guest"}, []string{"Main", "Guest"}, true},
		{[]string{"The Beatles"}, []string{"Beatles"}, true},
		{[]string{"Simon", "Garfunkel", "Guest"}, []string{"Simon & Garfunkel"}, true},
		{[]string{"Someone Else"}, []string{"Main"}, false},
		{[]string{"Future"}, []string{"Future Islands"}, false},
		{[]string{"Prince"}, []string{"Prince Royce"}, false},
		{nil, []string{"Main"}, false},
	} {
		if got := artistsOverlap(tc.local, tc.remote); got != tc.want {
			t.Errorf("artistsOverlap(%q, %q) = %v, want %v", tc.local, tc.remote, got, tc.want)
		}
	}
}

func TestTrackMatches(t *testing.T) {
	local := MatchTrack{Title: "Song (feat. Guest)", Artists: []string{"Main", "Guest"}, DurationMS: 200_400}
	remote := tidal.Track{Title: "Song", Artists: []string{"Main", "Guest"}, DurationMS: 201_000}
	if !trackMatches(local, remote, false) {
		t.Fatal("same title, artists and duration should match")
	}
	far := remote
	far.DurationMS = 240_000
	if trackMatches(local, far, false) {
		t.Fatal("a different length is another recording")
	}
	byOther := remote
	byOther.Artists = []string{"Cover Band"}
	if trackMatches(local, byOther, false) {
		t.Fatal("another artist's song with the same title matched")
	}
	sameISRC := tidal.Track{Title: "Totally Different", ISRC: "GBAYE0601498", DurationMS: 205_000}
	withISRC := local
	withISRC.ISRC = "GBAYE0601498"
	if !trackMatches(withISRC, sameISRC, false) {
		t.Fatal("the same ISRC is the same recording")
	}

	// Without artists or a duration, only a release already matched to the
	// track's album can vouch for it.
	bare := MatchTrack{Title: "Song"}
	if trackMatches(bare, remote, false) {
		t.Fatal("a bare title matched a search hit")
	}
	if !trackMatches(bare, remote, true) {
		t.Fatal("a bare title should match within its album's release")
	}
}

// pickTrack is the best of rankTracks.
func pickTrack(found []tidal.Track, t MatchTrack, albumTitle string) (tidal.Track, bool) {
	hits := rankTracks(found, t, albumTitle)
	if len(hits) == 0 {
		return tidal.Track{}, false
	}
	return hits[0], true
}

func TestPickTrackPrefersISRCAndArtistReleases(t *testing.T) {
	local := MatchTrack{Title: "Song", Artists: []string{"Main"}, DurationMS: 180_000}
	hits := []tidal.Track{
		{ID: "comp", Title: "Song", Artists: []string{"Main"}, DurationMS: 180_000, AlbumTitle: "Hits", AlbumArtist: "Various Artists"},
		{ID: "album", Title: "Song", Artists: []string{"Main"}, DurationMS: 180_000, AlbumTitle: "Record", AlbumArtist: "Main"},
		{ID: "live", Title: "Song (Live)", Artists: []string{"Main"}, DurationMS: 180_000, AlbumTitle: "Live", AlbumArtist: "Main"},
	}
	if got, ok := pickTrack(hits, local, ""); !ok || got.ID != "album" {
		t.Fatalf("picked %q, want the artist's own release", got.ID)
	}
	if got, ok := pickTrack(hits, local, "Hits"); !ok || got.ID != "comp" {
		t.Fatalf("picked %q, want the release of the track's album", got.ID)
	}
	if _, ok := pickTrack(hits, local, "Another Album"); ok {
		t.Fatal("picked a hit from another album")
	}
	hits[0].ISRC, local.ISRC = "GBAYE0601498", "GBAYE0601498"
	if got, _ := pickTrack(hits, local, ""); got.ID != "comp" {
		t.Fatalf("picked %q, want the ISRC match", got.ID)
	}
}

func TestFindInReleaseFillsReleaseMetadata(t *testing.T) {
	r := tidal.Album{
		ID: "rel", Title: "Record (Deluxe)", Artist: "Main", ReleaseYear: 2001, CoverURL: "https://resources.tidal.com/c.jpg",
		Tracks: []tidal.Track{
			{ID: "1", Title: "Intro", Artists: []string{"Main"}, DurationMS: 60_000, TrackNo: 1, DiscNo: 1},
			{ID: "2", Title: "Song", Artists: []string{"Main"}, DurationMS: 180_000, TrackNo: 2, DiscNo: 1, Removed: true},
			{ID: "3", Title: "Song", Artists: []string{"Main"}, DurationMS: 181_000, TrackNo: 2, DiscNo: 2},
		},
	}
	got, ok := assignRelease(r, []MatchTrack{{Title: "Song", Artists: []string{"Main"}, DurationMS: 180_500}}, false)[0]
	if !ok || got.ID != "3" {
		t.Fatalf("found %q, want the entry TIDAL still lists", got.ID)
	}
	if got.AlbumID != "rel" || got.AlbumTitle != "Record (Deluxe)" || got.AlbumArtist != "Main" ||
		got.Year != 2001 || got.DiscNo != 2 || got.TrackNo != 2 || got.CoverURL == "" {
		t.Fatalf("release metadata missing: %+v", got)
	}
	if n := len(assignRelease(r, []MatchTrack{
		{Title: "Intro", Artists: []string{"Main"}, DurationMS: 60_000},
		{Title: "Outro", Artists: []string{"Main"}, DurationMS: 60_000},
	}, false)); n != 1 {
		t.Fatalf("counted %d tracks on the release, want 1", n)
	}
}

// One release entry stands for one library track: two copies of a song
// don't both count toward (or take metadata from) the same entry.
func TestAssignReleaseIsOneToOne(t *testing.T) {
	r := tidal.Album{ID: "rel", Title: "Record", Tracks: []tidal.Track{
		{ID: "1", Title: "Song", Artists: []string{"Main"}, DurationMS: 180_000, TrackNo: 1},
		{ID: "2", Title: "Other", Artists: []string{"Main"}, DurationMS: 120_000, TrackNo: 2},
	}}
	got := assignRelease(r, []MatchTrack{
		{Title: "Song", Artists: []string{"Main"}, DurationMS: 181_500},
		{Title: "Song", Artists: []string{"Main"}, DurationMS: 180_200, TrackNo: 1},
	}, false)
	if len(got) != 1 || got[1].ID != "1" {
		t.Fatalf("assigned %+v; want only the closer copy on entry 1", got)
	}
}

// Sparse tracks (no duration, no artists) only count on a release their
// album is already linked to.
func TestAssignReleaseNeedsEvidenceUnlessLinked(t *testing.T) {
	r := tidal.Album{ID: "rel", Title: "Record", Tracks: []tidal.Track{
		{ID: "1", Title: "Song", Artists: []string{"Main"}, DurationMS: 180_000},
	}}
	sparse := []MatchTrack{{Title: "Song"}}
	if got := assignRelease(r, sparse, false); len(got) != 0 {
		t.Fatalf("a bare title counted toward an unlinked release: %+v", got)
	}
	if got := assignRelease(r, sparse, true); len(got) != 1 {
		t.Fatal("a bare title should match within its album's linked release")
	}
}

// As many tracks as possible are paired, even when the strongest pair for
// one track would leave another without its only entry.
func TestAssignReleaseMaximizesPairs(t *testing.T) {
	r := tidal.Album{ID: "rel", Title: "Record", Tracks: []tidal.Track{
		{ID: "x", Title: "Song", Artists: []string{"Main"}, DurationMS: 180_000, TrackNo: 1},
		{ID: "y", Title: "Song", Artists: []string{"Main"}, DurationMS: 183_000, TrackNo: 5},
	}}
	got := assignRelease(r, []MatchTrack{
		// A fits both, x better (same position); B fits only x.
		{Title: "Song", Artists: []string{"Main"}, DurationMS: 181_000, TrackNo: 1},
		{Title: "Song", Artists: []string{"Main"}, DurationMS: 178_000},
	}, false)
	if len(got) != 2 || got[0].ID != "y" || got[1].ID != "x" {
		t.Fatalf("assigned %+v; want A→y and B→x", got)
	}
}
