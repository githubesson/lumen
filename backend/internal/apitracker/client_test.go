package apitracker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

func TestExtractTrackerIDAndBaseURL(t *testing.T) {
	raw := "https://trackers.musicfiles.su/api/v1/trackers/42/entries?limit=50"
	if got := ExtractTrackerID(raw); got != 42 {
		t.Fatalf("tracker id = %d, want 42", got)
	}
	if got := ExtractBaseURL(raw); got != "https://trackers.musicfiles.su/api" {
		t.Fatalf("base url = %q", got)
	}
	if got := NormalizeBaseURL(raw); got != "https://trackers.musicfiles.su/api" {
		t.Fatalf("normalized base url = %q", got)
	}
}

func TestFetchEntriesPagesUntilComplete(t *testing.T) {
	var offsets []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/trackers/7/entries":
			offsets = append(offsets, r.URL.Query().Get("offset"))
			offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
			items := []Entry{}
			if offset == 0 {
				for i := 0; i < 500; i++ {
					items = append(items, Entry{ID: int64(i + 1), Links: []string{"https://example.com/a.mp3"}})
				}
			} else {
				items = append(items, Entry{ID: 501, Links: []string{"https://example.com/b.mp3"}})
			}
			_ = json.NewEncoder(w).Encode(entriesPage{
				Items:  items,
				Limit:  500,
				Offset: offset,
				Total:  501,
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	client := NewClient(srv.URL + "/api")
	entries, err := client.FetchEntries(context.Background(), 7)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 501 {
		t.Fatalf("len(entries) = %d, want 501", len(entries))
	}
	if len(offsets) != 2 || offsets[0] != "0" || offsets[1] != "500" {
		t.Fatalf("offsets = %#v, want [0 500]", offsets)
	}
}

func TestFetchErasAndEraImage(t *testing.T) {
	imageBytes := []byte{0x89, 'P', 'N', 'G'}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/trackers/7/eras":
			_ = json.NewEncoder(w).Encode(erasPage{
				Items: []Era{{
					Era:      "Working On Dying",
					EraKey:   "working on dying",
					ImageID:  12,
					ImageURL: "/api/v1/era-images/12",
				}},
				Total: 1,
			})
		case "/api/v1/era-images/12":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(imageBytes)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	client := NewClient(srv.URL + "/api")
	eras, err := client.FetchEras(context.Background(), 7)
	if err != nil {
		t.Fatal(err)
	}
	if len(eras) != 1 || eras[0].ImageID != 12 || eras[0].EraKey != "working on dying" {
		t.Fatalf("unexpected eras: %#v", eras)
	}
	data, contentType, err := client.FetchEraImage(context.Background(), 12)
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "image/png" || string(data) != string(imageBytes) {
		t.Fatalf("unexpected image response type=%q data=%#v", contentType, data)
	}
}
