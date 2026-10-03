package tidal

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

const detailsTrack = `{"id":123,"title":"Song","isrc":" USX1 ","copyright":" (P) 2023 Label ","bpm":139.6,"key":"FSharp","keyScale":"MINOR",` +
	`"audioQuality":"LOSSLESS","audioModes":["STEREO"],"mediaMetadata":{"tags":["LOSSLESS","HIRES_LOSSLESS"]},` +
	`"streamStartDate":"2023-03-10T00:00:00.000+0000",` +
	`"artists":[{"name":"Main","type":"MAIN"},{"name":"Guest","type":"FEATURED"},{"name":"Second","type":"MAIN"},{"name":"main","type":"FEATURED"}],` +
	`"album":{"id":77,"title":"Album"}}`

func detailsServer(t *testing.T, body string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/lumen/track" || r.URL.Query().Get("id") != "123" {
			t.Errorf("unexpected track request %s", r.URL)
		}
		_, _ = fmt.Fprint(w, body)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestTrackDetails(t *testing.T) {
	server := detailsServer(t, `{"track":`+detailsTrack+`,"album":{"releaseDate":"2023-03-17"},`+
		`"credits":[{"type":"Producer","names":[" Maker ",""]},{"type":"Main Artist","names":["Main"]},{"type":"Mixer","names":[]},{"type":"Composer","names":["Writer"]}],`+
		`"failed_sections":[]}`)
	d, err := NewClient(Config{HifiAPIURL: server.URL, Quality: "HI_RES_LOSSLESS"}).TrackDetails(context.Background(), "123")
	if err != nil {
		t.Fatal(err)
	}
	want := TrackDetails{
		ID:              "123",
		MainArtists:     []string{"Main", "Second"},
		FeaturedArtists: []string{"Guest"},
		ReleaseDate:     "2023-03-17",
		Copyright:       "(P) 2023 Label",
		ISRC:            "USX1",
		BPM:             140,
		Key:             "F♯ minor",
		Quality:         "HI_RES_LOSSLESS",
		Stereo:          true,
		Credits:         []Credit{{Role: "Producer", Names: []string{"Maker"}}, {Role: "Composer", Names: []string{"Writer"}}},
	}
	if !reflect.DeepEqual(d, want) {
		t.Fatalf("details =\n%+v\nwant\n%+v", d, want)
	}
}

func TestTrackDetailsFailedSections(t *testing.T) {
	server := detailsServer(t, `{"track":`+detailsTrack+`,"album":null,"credits":[],"failed_sections":["album","credits"]}`)
	d, err := NewClient(Config{HifiAPIURL: server.URL}).TrackDetails(context.Background(), "123")
	if err != nil {
		t.Fatal(err)
	}
	// Without the album, the day TIDAL started streaming it stands in.
	if d.ReleaseDate != "2023-03-10" || !d.CreditsFailed || len(d.Credits) != 0 || d.Credits == nil {
		t.Fatalf("%+v", d)
	}
}

func TestTrackDetailsRejectsBrokenResponses(t *testing.T) {
	for name, body := range map[string]string{
		"older sidecar":   `{"version":"2.10","data":` + detailsTrack + `}`,
		"no credits":      `{"track":` + detailsTrack + `,"album":null,"failed_sections":[]}`,
		"no status":       `{"track":` + detailsTrack + `,"album":null,"credits":[]}`,
		"untitled track":  `{"track":{"id":123},"album":null,"credits":[],"failed_sections":[]}`,
		"unknown section": `{"track":` + detailsTrack + `,"album":null,"credits":[],"failed_sections":["lyrics"]}`,
	} {
		t.Run(name, func(t *testing.T) {
			server := detailsServer(t, body)
			if _, err := NewClient(Config{HifiAPIURL: server.URL}).TrackDetails(context.Background(), "123"); err == nil {
				t.Fatal("want an error")
			}
		})
	}
}

func TestTrackDetailsInvalidID(t *testing.T) {
	c := NewClient(Config{HifiAPIURL: "http://127.0.0.1:1"})
	for _, id := range []string{"", "0", "000", "-1", "12a", "1/2", "../x"} {
		if _, err := c.TrackDetails(context.Background(), id); !errors.Is(err, ErrInvalidID) {
			t.Errorf("%q: err = %v", id, err)
		}
	}
}

func TestStreamQuality(t *testing.T) {
	for _, tc := range []struct {
		configured, audioQuality, want string
		tags                             []string
	}{
		{"HI_RES_LOSSLESS", "LOSSLESS", "HI_RES_LOSSLESS", []string{"LOSSLESS", "HIRES_LOSSLESS"}},
		{"MAX", "LOSSLESS", "HI_RES_LOSSLESS", []string{"HIRES_LOSSLESS"}},
		// The default setting is lossless, whatever TIDAL has.
		{"", "LOSSLESS", "LOSSLESS", []string{"HIRES_LOSSLESS"}},
		{"LOSSLESS", "LOSSLESS", "LOSSLESS", []string{"LOSSLESS"}},
		{"HIGH", "LOSSLESS", "HIGH", []string{"LOSSLESS"}},
		{"low", "LOSSLESS", "LOW", nil},
		// A track TIDAL only has lossy plays lossy.
		{"HI_RES_LOSSLESS", "HIGH", "HIGH", nil},
		{"LOSSLESS", "hi_res", "LOSSLESS", nil},
		{"LOSSLESS", "", "", nil},
		{"LOSSLESS", "SOMETHING_NEW", "", []string{"DOLBY_ATMOS"}},
	} {
		got := streamQuality(tc.configured, availableQuality(tc.tags, tc.audioQuality))
		if got != tc.want {
			t.Errorf("%+v: got %q", tc, got)
		}
	}
}

func TestMusicalKey(t *testing.T) {
	for _, tc := range []struct{ key, scale, want string }{
		{"C", "MAJOR", "C major"},
		{"FSharp", "MINOR", "F♯ minor"},
		{"Eb", "minor", "E♭ minor"},
		{"A", "", "A"},
		{"A", "UNKNOWN", "A"},
		{"D", "HARMONIC_MINOR", "D harmonic minor"},
		{"D", "<b>", "D"},
		{"UNKNOWN", "MAJOR", ""},
		{"H", "MAJOR", ""},
		{"", "", ""},
	} {
		if got := musicalKey(tc.key, tc.scale); got != tc.want {
			t.Errorf("musicalKey(%q, %q) = %q, want %q", tc.key, tc.scale, got, tc.want)
		}
	}
}

func TestISODate(t *testing.T) {
	for in, want := range map[string]string{
		"2023-03-17":                   "2023-03-17",
		"2023-03-17T00:00:00.000+0000": "2023-03-17",
		" 1969-09-26 ":                 "1969-09-26",
		"2023-13-01":                   "",
		"2023":                         "",
		"":                             "",
	} {
		if got := isoDate(in); got != want {
			t.Errorf("isoDate(%q) = %q, want %q", in, got, want)
		}
	}
}
