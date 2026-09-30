package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPlaylistTracksValidator(t *testing.T) {
	rows := tracksResp{Tracks: []trackItem{{TrackID: "track", Title: "Original"}}}
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	first := httptest.NewRecorder()
	writePlaylistTracks(first, request, rows)
	request.Header.Set("If-None-Match", first.Header().Get("ETag"))
	unchanged := httptest.NewRecorder()
	writePlaylistTracks(unchanged, request, rows)
	if unchanged.Code != http.StatusNotModified || unchanged.Body.Len() != 0 {
		t.Fatalf("unchanged rows: status %d, body %q", unchanged.Code, unchanged.Body.String())
	}
	rows.Tracks[0].Title = "Edited"
	edited := httptest.NewRecorder()
	writePlaylistTracks(edited, request, rows)
	if edited.Code != http.StatusOK || edited.Header().Get("ETag") == first.Header().Get("ETag") {
		t.Fatal("track metadata changes must invalidate the response")
	}
}
