package handlers

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/library"
)

func TestReplayResponseIncludesTIDALAlbumNavigation(t *testing.T) {
	materializedID := uuid.New()
	resp := toReplayResp(&library.ReplayData{
		TopAlbums: []library.ReplayAlbum{
			{
				ID:            materializedID,
				Title:         "Album",
				Artist:        "Artist",
				Source:        "tidal",
				SourceAlbumID: "12345",
				Plays:         7,
			},
		},
	})

	if len(resp.TopAlbums) != 1 {
		t.Fatalf("got %d top albums, want 1", len(resp.TopAlbums))
	}
	album := resp.TopAlbums[0]
	if album.ID != materializedID.String() {
		t.Fatalf("album id = %q, want %q", album.ID, materializedID)
	}
	if album.Source != "tidal" {
		t.Fatalf("album source = %q, want tidal", album.Source)
	}
	if album.SourceAlbumID != "12345" {
		t.Fatalf("source album id = %q, want 12345", album.SourceAlbumID)
	}
}

func TestReplayResponseSaysWhichArtistsHaveAPage(t *testing.T) {
	page, none := uuid.New(), uuid.New()
	resp := toReplayResp(&library.ReplayData{
		TopTracks: []library.ReplayTrack{{
			TrackListItem: library.TrackListItem{ID: uuid.New(), Artist: "Earth, Wind & Fire, Guest"},
			PrimaryArtists: []library.ReplayTrackArtist{
				{ID: none, Name: "Earth, Wind & Fire"},
				{ID: page, Name: "Guest", HasPage: true},
			},
		}},
		TopArtists: []library.ReplayArtist{{ID: page, Name: "Guest", HasPage: true}, {ID: none, Name: "Earth, Wind & Fire"}},
	})
	body, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"primary_artists":[{"id":"` + none.String() + `","name":"Earth, Wind \u0026 Fire","has_page":false},{"id":"` + page.String() + `","name":"Guest","has_page":true}]`,
		`"top_artists":[{"id":"` + page.String() + `","name":"Guest","plays":0,"has_page":true},{"id":"` + none.String() + `","name":"Earth, Wind \u0026 Fire","plays":0,"has_page":false}]`,
	} {
		if !strings.Contains(string(body), want) {
			t.Errorf("response lacks %s:\n%s", want, body)
		}
	}
}

func TestAlbumResponseSaysWhetherItsArtistHasAPage(t *testing.T) {
	artist := uuid.New()
	for _, hasPage := range []bool{true, false} {
		body, err := json.Marshal(makeAlbumResp(&library.AlbumDetail{
			AlbumListItem: library.AlbumListItem{ID: uuid.New(), ArtistID: &artist, ArtistName: "Band"},
			ArtistHasPage: hasPage,
		}))
		if err != nil {
			t.Fatal(err)
		}
		// Present only when true, so list and search rows (which don't
		// compute it) never claim there is no page.
		if got := strings.Contains(string(body), `"artist_has_page":true`); got != hasPage {
			t.Errorf("has_page=%v: %s", hasPage, body)
		}
		if strings.Contains(string(body), `"artist_has_page":false`) {
			t.Errorf("sent a false artist_has_page: %s", body)
		}
	}
}
