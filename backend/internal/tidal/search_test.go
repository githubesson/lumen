package tidal

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCatalogSearchPaginationAndMetadata(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("q") != "hello" || r.URL.Query().Get("limit") != "2" || r.URL.Query().Get("offset") != "7" {
			t.Errorf("wrong pagination: %s", r.URL)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/lumen/search/albums":
			_, _ = fmt.Fprint(w, `{"data":{"items":[{"id":"123","title":"Album","artist":{"name":"Artist"},"numberOfTracks":12,"duration":120,"releaseDate":"2024-01-01","cover":"a-b-c"},{"id":456}]}}`)
		case "/lumen/search/artists":
			_, _ = fmt.Fprint(w, `{"data":{"items":[{"id":123,"name":"Artist","picture":"a-b-c"},{"name":"Missing ID"}]}}`)
		default:
			t.Errorf("unexpected endpoint %s", r.URL.Path)
		}
	}))
	defer server.Close()
	c := NewClient(Config{HifiAPIURL: server.URL})
	albums, consumed, err := c.SearchAlbums(context.Background(), " hello ", 2, 7)
	if err != nil || consumed != 2 || len(albums) != 1 {
		t.Fatalf("%+v consumed=%d err=%v", albums, consumed, err)
	}
	if albums[0].ID != "123" || albums[0].Artist != "Artist" || albums[0].TrackCount != 12 || albums[0].ReleaseYear != 2024 || albums[0].DurationMS != 120000 || albums[0].CoverURL == "" {
		t.Fatal(albums[0])
	}
	artists, consumed, err := c.SearchArtists(context.Background(), "hello", 2, 7)
	if err != nil || consumed != 2 || len(artists) != 1 {
		t.Fatalf("%+v consumed=%d err=%v", artists, consumed, err)
	}
	if artists[0].ID != "123" || artists[0].CoverURL != "https://resources.tidal.com/images/a/b/c/750x750.jpg" {
		t.Fatal(artists[0])
	}
}

func TestArtistReleasesUsesBoundedAggregation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/lumen/artist" || r.URL.Query().Get("id") != "123" {
			t.Errorf("unexpected artist request %s", r.URL)
		}
		_, _ = fmt.Fprint(w, `{"artist":{"name":"Artist","picture":"a-b-c"},"albums":{"items":[{"id":456,"title":"Release"}]},"tracks":[{"id":789,"title":"Top song"}],"failed_sections":[]}`)
	}))
	defer server.Close()
	result, err := NewClient(Config{HifiAPIURL: server.URL}).ArtistReleases(context.Background(), "123")
	if err != nil || len(result.Albums) != 1 || len(result.Tracks) != 1 {
		t.Fatalf("%+v %v", result, err)
	}
	want := Artist{ID: "123", Name: "Artist", CoverURL: "https://resources.tidal.com/images/a/b/c/750x750.jpg"}
	if result.Artist == nil || *result.Artist != want {
		t.Fatalf("artist = %+v, want %+v", result.Artist, want)
	}
}

// TIDAL lists an album's explicit, clean and Dolby Atmos versions as separate
// albums; these fields are what tell them apart.
func TestArtistReleasesCarryVersionFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprint(w, `{"albums":{"items":[`+
			`{"id":1,"title":"Record","explicit":true,"version":null,"audioModes":["STEREO"]},`+
			`{"id":2,"title":"Record","explicit":false,"audioModes":["STEREO"]},`+
			`{"id":3,"title":"Record","explicit":true,"audioModes":["DOLBY_ATMOS"]},`+
			`{"id":4,"title":"Record","version":" Deluxe ","audioModes":["STEREO","DOLBY_ATMOS"]}`+
			`]},"tracks":[],"failed_sections":[]}`)
	}))
	defer server.Close()
	result, err := NewClient(Config{HifiAPIURL: server.URL}).ArtistReleases(context.Background(), "123")
	if err != nil || len(result.Albums) != 4 {
		t.Fatalf("%+v %v", result, err)
	}
	type fields struct {
		version              string
		explicit, dolbyAtmos bool
	}
	// An album also offered in stereo isn't an Atmos version.
	for i, want := range []fields{{"", true, false}, {"", false, false}, {"", true, true}, {"Deluxe", false, false}} {
		a := result.Albums[i]
		if got := (fields{a.Version, a.Explicit, a.DolbyAtmos}); got != want {
			t.Errorf("album %s: %+v, want %+v", a.ID, got, want)
		}
	}
}

func TestArtistReleasesToleratesMissingProfile(t *testing.T) {
	for name, profile := range map[string]string{
		"null profile":    `"artist":null,`,
		"absent profile":  ``,
		"nameless":        `"artist":{"picture":"a-b-c"},`,
		"picture missing": `"artist":{"name":"Artist","picture":null},`,
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = fmt.Fprintf(w, `{%s"albums":{"items":[]},"tracks":[],"failed_sections":[]}`, profile)
			}))
			defer server.Close()
			result, err := NewClient(Config{HifiAPIURL: server.URL}).ArtistReleases(context.Background(), "123")
			if err != nil {
				t.Fatal(err)
			}
			if name == "picture missing" {
				if result.Artist == nil || result.Artist.Name != "Artist" || result.Artist.CoverURL != "" {
					t.Fatalf("artist = %+v", result.Artist)
				}
			} else if result.Artist != nil {
				t.Fatalf("artist = %+v, want nil", result.Artist)
			}
		})
	}
}

func TestArtistReleasesFailureContract(t *testing.T) {
	for _, tc := range []struct {
		name      string
		status    int
		body      string
		wantError bool
		warnings  int
		albums    int
	}{
		{"total failure", 502, `{"detail":"TIDAL artist unavailable"}`, true, 0, 0},
		{"partial releases", 200, `{"albums":{"items":[{"id":456,"title":"Release"}]},"tracks":[],"failed_sections":["singles","tracks"]}`, false, 2, 1},
		{"incomplete empty", 200, `{"albums":{"items":[]},"tracks":[],"failed_sections":["albums"]}`, false, 1, 0},
		{"confirmed empty", 200, `{"albums":{"items":[]},"tracks":[],"failed_sections":[]}`, false, 0, 0},
		{"missing status", 200, `{"albums":{"items":[]},"tracks":[]}`, true, 0, 0},
		{"missing data", 200, `{"failed_sections":[]}`, true, 0, 0},
		{"unknown status", 200, `{"albums":{"items":[]},"tracks":[],"failed_sections":["unknown"]}`, true, 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = fmt.Fprint(w, tc.body)
			}))
			defer server.Close()
			result, err := NewClient(Config{HifiAPIURL: server.URL}).ArtistReleases(context.Background(), "123")
			if (err != nil) != tc.wantError || len(result.Warnings) != tc.warnings || len(result.Albums) != tc.albums {
				t.Fatalf("result=%+v err=%v", result, err)
			}
		})
	}
}
