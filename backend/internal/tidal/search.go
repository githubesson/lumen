package tidal

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

type Artist struct {
	ID, Name, CoverURL string
}

// TIDAL serves artist pictures at 160, 320, 480 and 750 px only; the 640 px
// album cover size answers 403 for them.
const artistPictureSize = 750

func (c *Client) searchCatalog(ctx context.Context, kind, query string, limit, offset int, out any) error {
	if strings.TrimSpace(c.cfg.HifiAPIURL) == "" {
		return ErrNotConfigured
	}
	u := c.hifiURL("/lumen/search/" + kind)
	q := u.Query()
	q.Set("q", strings.TrimSpace(query))
	q.Set("limit", strconv.Itoa(max(1, min(50, limit))))
	q.Set("offset", strconv.Itoa(max(0, offset)))
	u.RawQuery = q.Encode()
	return c.doHifiJSON(ctx, u.String(), out)
}

func (c *Client) SearchAlbums(ctx context.Context, query string, limit, offset int) ([]Album, int, error) {
	var out struct {
		Data struct {
			Items []apiAlbum `json:"items"`
		} `json:"data"`
	}
	if err := c.searchCatalog(ctx, "albums", query, limit, offset, &out); err != nil {
		return nil, 0, err
	}
	albums := make([]Album, 0, len(out.Data.Items))
	for _, item := range out.Data.Items {
		if item.ID != "" && item.Title != "" {
			albums = append(albums, item.album())
		}
	}
	return albums, len(out.Data.Items), nil
}

func (c *Client) SearchArtists(ctx context.Context, query string, limit, offset int) ([]Artist, int, error) {
	var out struct {
		Data struct {
			Items []apiArtist `json:"items"`
		} `json:"data"`
	}
	if err := c.searchCatalog(ctx, "artists", query, limit, offset, &out); err != nil {
		return nil, 0, err
	}
	artists := make([]Artist, 0, len(out.Data.Items))
	for _, item := range out.Data.Items {
		if item.ID != "" && item.Name != "" {
			artists = append(artists, Artist{ID: string(item.ID), Name: item.Name, CoverURL: CoverURL(item.Picture, artistPictureSize)})
		}
	}
	return artists, len(out.Data.Items), nil
}

type ArtistReleases struct {
	// Artist is nil when the proxy couldn't load the profile; the releases
	// are still usable without it.
	Artist   *Artist
	Albums   []Album
	Tracks   []Track
	Warnings []string
}

func (c *Client) ArtistReleases(ctx context.Context, id string) (ArtistReleases, error) {
	if strings.TrimSpace(c.cfg.HifiAPIURL) == "" {
		return ArtistReleases{}, ErrNotConfigured
	}
	u := c.hifiURL("/lumen/artist")
	q := u.Query()
	q.Set("id", id)
	u.RawQuery = q.Encode()
	var out struct {
		Artist *apiArtist `json:"artist"`
		Albums struct {
			Items []apiAlbum `json:"items"`
		} `json:"albums"`
		Tracks         []apiTrack `json:"tracks"`
		FailedSections []string   `json:"failed_sections"`
		// TIDAL's reason for each failed section it refused.
		RefusedSections map[string]string `json:"refused_sections"`
	}
	if err := c.doHifiJSON(ctx, u.String(), &out); err != nil {
		return ArtistReleases{}, err
	}
	result := ArtistReleases{}
	// Require the extension's explicit status contract; a legacy or malformed
	// success response must not be presented as an empty artist.
	if out.FailedSections == nil || out.Albums.Items == nil || out.Tracks == nil {
		return ArtistReleases{}, fmt.Errorf("invalid tidal artist response")
	}
	for _, section := range out.FailedSections {
		var name string
		switch section {
		case "albums":
			name = "albums"
		case "singles":
			name = "singles and EPs"
		case "tracks":
			name = "top songs"
		default:
			return ArtistReleases{}, fmt.Errorf("invalid tidal artist section status")
		}
		detail, refused := out.RefusedSections[section]
		switch reason := cleanRefusalReason(detail); {
		case !refused:
			result.Warnings = append(result.Warnings, "Couldn't load "+name+".")
		case reason != "":
			result.Warnings = append(result.Warnings, "TIDAL refused this artist's "+name+": "+reason)
		default:
			result.Warnings = append(result.Warnings, "TIDAL refused this artist's "+name+".")
		}
	}
	if out.Artist != nil && strings.TrimSpace(out.Artist.Name) != "" {
		result.Artist = &Artist{ID: id, Name: out.Artist.Name, CoverURL: CoverURL(out.Artist.Picture, artistPictureSize)}
	}
	for _, item := range out.Albums.Items {
		if item.ID != "" && item.Title != "" {
			result.Albums = append(result.Albums, item.album())
		}
	}
	for _, item := range out.Tracks {
		if item.ID != "" && item.Title != "" {
			result.Tracks = append(result.Tracks, item.track())
		}
	}
	return result, nil
}
