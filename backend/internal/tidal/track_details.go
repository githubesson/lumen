package tidal

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"
)

// TrackDetails is what TIDAL knows about a track beyond what Track keeps.
// The track info view fetches it on request; nothing stores it, since a
// saved copy carries its own tags.
type TrackDetails struct {
	ID              string
	MainArtists     []string
	FeaturedArtists []string
	// ReleaseDate is YYYY-MM-DD: the album's release date, else the day
	// TIDAL started streaming the track.
	ReleaseDate string
	Copyright   string
	ISRC        string
	BPM         int
	Key         string // e.g. "F♯ minor"
	// StreamedQuality is the tier of the stream this server is serving for
	// the track right now; "" when it hasn't resolved one lately.
	StreamedQuality string
	// MaxQuality is the best tier this server would ask for: TIDAL's best
	// for the track, capped by the configured quality. Playback can still
	// fall back lower. "" when unknown.
	MaxQuality string
	Stereo     bool
	Credits    []Credit
	// CreditsFailed means TIDAL's credits couldn't be loaded, so an empty
	// Credits doesn't mean there are none.
	CreditsFailed bool
}

// Credit is one role on a track and who filled it, in TIDAL's order.
type Credit struct {
	Role  string
	Names []string
}

type apiTrackDetails struct {
	apiTrack
	StreamStartDate string   `json:"streamStartDate"`
	Copyright       string   `json:"copyright"`
	BPM             *float64 `json:"bpm"`
	Key             string   `json:"key"`
	KeyScale        string   `json:"keyScale"`
	AudioQuality    string   `json:"audioQuality"`
	AudioModes      []string `json:"audioModes"`
	MediaMetadata   struct {
		Tags []string `json:"tags"`
	} `json:"mediaMetadata"`
}

var digitsOnly = regexp.MustCompile(`^[0-9]+$`)

// ErrInvalidID reports an id TIDAL could never have issued.
var ErrInvalidID = errors.New("invalid tidal id")

// TrackDetails loads one track's details through the extension's
// /lumen/track route, which adds its album's release date and its credits.
func (c *Client) TrackDetails(ctx context.Context, id string) (TrackDetails, error) {
	id = strings.TrimSpace(id)
	if !digitsOnly.MatchString(id) || strings.Trim(id, "0") == "" {
		return TrackDetails{}, ErrInvalidID
	}
	if strings.TrimSpace(c.cfg.HifiAPIURL) == "" {
		return TrackDetails{}, ErrNotConfigured
	}
	u := c.hifiURL("/lumen/track")
	q := u.Query()
	q.Set("id", id)
	u.RawQuery = q.Encode()
	var out struct {
		Track *apiTrackDetails `json:"track"`
		Album *struct {
			ReleaseDate string `json:"releaseDate"`
		} `json:"album"`
		Credits []struct {
			Type  string   `json:"type"`
			Names []string `json:"names"`
		} `json:"credits"`
		FailedSections []string `json:"failed_sections"`
	}
	if err := c.doHifiJSON(ctx, u.String(), &out); err != nil {
		return TrackDetails{}, err
	}
	// Require the extension's contract, so an older sidecar without the
	// route's fields can't pass for a track with no credits.
	if out.Track == nil || out.Credits == nil || out.FailedSections == nil {
		return TrackDetails{}, fmt.Errorf("invalid tidal track response")
	}
	t := out.Track
	if string(t.ID) == "" || strings.TrimSpace(t.Title) == "" {
		return TrackDetails{}, fmt.Errorf("invalid tidal track response")
	}
	d := TrackDetails{
		ID:              string(t.ID),
		Copyright:       strings.TrimSpace(t.Copyright),
		ISRC:            strings.TrimSpace(t.ISRC),
		Key:             musicalKey(t.Key, t.KeyScale),
		StreamedQuality: c.streamedQuality(string(t.ID)),
		MaxQuality:      streamQuality(c.cfg.Quality, availableQuality(t.MediaMetadata.Tags, t.AudioQuality)),
		Credits:         []Credit{},
	}
	if t.BPM != nil && *t.BPM > 0 && *t.BPM < 1000 {
		d.BPM = int(math.Round(*t.BPM))
	}
	for _, mode := range t.AudioModes {
		if strings.EqualFold(mode, "STEREO") {
			d.Stereo = true
		}
	}
	seen := map[string]bool{}
	for _, a := range t.Artists {
		name := strings.TrimSpace(a.Name)
		if name == "" || seen[strings.ToLower(name)] {
			continue
		}
		seen[strings.ToLower(name)] = true
		if strings.EqualFold(a.Type, "FEATURED") {
			d.FeaturedArtists = append(d.FeaturedArtists, name)
		} else {
			d.MainArtists = append(d.MainArtists, name)
		}
	}
	if out.Album != nil {
		d.ReleaseDate = isoDate(out.Album.ReleaseDate)
	}
	if d.ReleaseDate == "" {
		d.ReleaseDate = isoDate(t.StreamStartDate)
	}
	for _, section := range out.FailedSections {
		switch section {
		case "credits":
			d.CreditsFailed = true
		case "album":
			// The stream start date above stands in for it.
		default:
			return TrackDetails{}, fmt.Errorf("invalid tidal track section status")
		}
	}
	for _, credit := range out.Credits {
		role := strings.TrimSpace(credit.Type)
		// The track's own artist list already says who the artists are.
		if role == "" || strings.EqualFold(role, "Main Artist") || strings.EqualFold(role, "Featured Artist") {
			continue
		}
		names := []string{}
		for _, name := range credit.Names {
			if name = strings.TrimSpace(name); name != "" {
				names = append(names, name)
			}
		}
		if len(names) > 0 {
			d.Credits = append(d.Credits, Credit{Role: role, Names: names})
		}
	}
	return d, nil
}

// isoDate keeps the YYYY-MM-DD of a TIDAL date ("2023-03-17" or
// "2023-03-17T00:00:00.000+0000"), or "" if it isn't one.
func isoDate(s string) string {
	s = strings.TrimSpace(s)
	if len(s) < 10 {
		return ""
	}
	if _, err := time.Parse("2006-01-02", s[:10]); err != nil {
		return ""
	}
	return s[:10]
}

var qualityRank = map[string]int{"LOW": 1, "HIGH": 2, "LOSSLESS": 3, "HI_RES_LOSSLESS": 4}

// availableQuality is the best quality TIDAL offers a track at. The tags
// name hi-res availability, which audioQuality stopped reporting.
func availableQuality(tags []string, audioQuality string) string {
	has := func(want string) bool {
		for _, tag := range tags {
			if strings.EqualFold(tag, want) {
				return true
			}
		}
		return false
	}
	switch {
	case has("HIRES_LOSSLESS"):
		return "HI_RES_LOSSLESS"
	case has("LOSSLESS"):
		return "LOSSLESS"
	}
	switch q := strings.ToUpper(strings.TrimSpace(audioQuality)); q {
	case "HI_RES_LOSSLESS", "LOSSLESS", "HIGH", "LOW":
		return q
	case "HI_RES":
		// MQA, which TIDAL now serves as plain lossless.
		return "LOSSLESS"
	}
	return ""
}

// streamQuality caps what TIDAL offers by what this server asks for (see
// hifiQualityAttempts).
func streamQuality(configured, available string) string {
	if available == "" {
		return ""
	}
	limit := "LOSSLESS"
	switch defaultQuality(configured) {
	case "HI_RES", "HI_RES_LOSSLESS", "MAX":
		limit = "HI_RES_LOSSLESS"
	case "HIGH":
		limit = "HIGH"
	case "LOW":
		limit = "LOW"
	}
	if qualityRank[available] < qualityRank[limit] {
		return available
	}
	return limit
}

var (
	keyNote  = regexp.MustCompile(`^([A-G])(Sharp|b)?$`)
	keyScale = regexp.MustCompile(`^[a-z]+(_[a-z]+)*$`)
)

// musicalKey reads TIDAL's key ("FSharp", "Eb") and scale ("MINOR") as
// "F♯ minor", or "" when TIDAL doesn't know it.
func musicalKey(key, scale string) string {
	m := keyNote.FindStringSubmatch(strings.TrimSpace(key))
	if m == nil {
		return ""
	}
	note := m[1]
	switch m[2] {
	case "Sharp":
		note += "♯"
	case "b":
		note += "♭"
	}
	scale = strings.ToLower(strings.TrimSpace(scale))
	if scale == "unknown" || !keyScale.MatchString(scale) {
		return note
	}
	return note + " " + strings.ReplaceAll(scale, "_", " ")
}
