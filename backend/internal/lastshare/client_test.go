package lastshare

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

const sampleID = "FiHRnVVcdQFZ6mD"

func TestParseShareID(t *testing.T) {
	tests := map[string]string{
		"https://lastshare.org/share/" + sampleID:          sampleID,
		"https://lastshare.org/s/" + sampleID:              sampleID,
		"https://lastshare.org/d/" + sampleID:              sampleID,
		"https://lastshare.org/embed/share/" + sampleID:    sampleID,
		"https://lastshare.org/share/" + sampleID + "?x=1": sampleID,
		"https://lastshare.org/api/shares/" + sampleID:     "", // API URL, not a share page
		"https://lastshare.org/":                           "",
		"https://lastshare.org/share/has.a.dot":            "", // invalid id chars
		sampleID:                                           "", // a bare id is not a URL
	}
	for input, want := range tests {
		if got := ParseShareID(input); got != want {
			t.Errorf("ParseShareID(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestIsShareURL(t *testing.T) {
	yes := []string{
		"https://lastshare.org/share/" + sampleID,
		"https://lastshare.org/s/" + sampleID,
		"http://lastshare.org/d/" + sampleID,
	}
	for _, u := range yes {
		if !IsShareURL(u) {
			t.Errorf("IsShareURL(%q) = false, want true", u)
		}
	}
	no := []string{
		"https://lastshare.org/api/shares/" + sampleID + "/files/abc", // resolved per-file URL
		"https://example.com/share/" + sampleID,                       // wrong host
		"https://lastshare.org/",
		"https://pillows.su/f/" + sampleID,
	}
	for _, u := range no {
		if IsShareURL(u) {
			t.Errorf("IsShareURL(%q) = true, want false", u)
		}
	}
}

func TestResolve(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/shares/"+sampleID {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		// `size` is intentionally a string on the first file and a number on
		// the second — that is exactly what the real endpoint returns.
		io.WriteString(w, `{"id":"`+sampleID+`","name":"Ken Carson - Hiya","files":[`+
			`{"id":"6e47d638","name":"hiya.m4a","size":"301895","relativePath":"hiya.m4a"},`+
			`{"id":"d3c4fdb2","name":"hiya.mov","size":6594569,"relativePath":"hiya.mov"}]}`)
	}))
	defer srv.Close()

	c := &Client{HTTP: srv.Client()}
	share, err := c.Resolve(context.Background(), srv.URL+"/share/"+sampleID)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if share.Name != "Ken Carson - Hiya" {
		t.Errorf("share.Name = %q", share.Name)
	}
	if len(share.Files) != 2 {
		t.Fatalf("len(share.Files) = %d, want 2", len(share.Files))
	}
	if share.Files[0].Size != 301895 { // decoded from a JSON string
		t.Errorf("Files[0].Size = %d, want 301895", share.Files[0].Size)
	}
	if share.Files[1].Size != 6594569 { // decoded from a JSON number
		t.Errorf("Files[1].Size = %d, want 6594569", share.Files[1].Size)
	}
	want := srv.URL + "/api/shares/" + sampleID + "/files/6e47d638"
	if share.Files[0].DownloadURL != want {
		t.Errorf("Files[0].DownloadURL = %q, want %q", share.Files[0].DownloadURL, want)
	}
}

func TestResolveNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()

	c := &Client{HTTP: srv.Client()}
	if _, err := c.Resolve(context.Background(), srv.URL+"/share/missing"); err == nil {
		t.Fatal("Resolve of a missing share = nil error, want error")
	}
}
