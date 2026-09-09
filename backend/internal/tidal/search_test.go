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
			fmt.Fprint(w, `{"data":{"items":[{"id":"123","title":"Album","artist":{"name":"Artist"},"numberOfTracks":12,"duration":120,"releaseDate":"2024-01-01","cover":"a-b-c"},{"id":456}]}}`)
		case "/lumen/search/artists":
			fmt.Fprint(w, `{"data":{"items":[{"id":123,"name":"Artist","picture":"a-b-c"},{"name":"Missing ID"}]}}`)
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
	if artists[0].ID != "123" || artists[0].CoverURL == "" {
		t.Fatal(artists[0])
	}
}

func TestArtistReleasesUsesBoundedAggregation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/artist/" || r.URL.Query().Get("f") != "123" || r.URL.Query().Get("skip_tracks") != "true" {
			t.Errorf("unexpected artist request %s", r.URL)
		}
		fmt.Fprint(w, `{"albums":{"items":[{"id":456,"title":"Release"}]},"tracks":[{"id":789,"title":"Top song"}]}`)
	}))
	defer server.Close()
	result, err := NewClient(Config{HifiAPIURL: server.URL}).ArtistReleases(context.Background(), "123")
	if err != nil || len(result.Albums) != 1 || len(result.Tracks) != 1 {
		t.Fatalf("%+v %v", result, err)
	}
}
