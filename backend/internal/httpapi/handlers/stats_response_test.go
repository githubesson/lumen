package handlers

import (
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
