package tidal

import (
	"context"
	"strconv"
	"strings"
)

type Artist struct {
	ID, Name, CoverURL string
}

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
			artists = append(artists, Artist{ID: string(item.ID), Name: item.Name, CoverURL: CoverURL(item.Picture, 640)})
		}
	}
	return artists, len(out.Data.Items), nil
}

type ArtistReleases struct {
	Albums []Album
	Tracks []Track
}

func (c *Client) ArtistReleases(ctx context.Context, id string) (ArtistReleases, error) {
	if strings.TrimSpace(c.cfg.HifiAPIURL) == "" {
		return ArtistReleases{}, ErrNotConfigured
	}
	u := c.hifiURL("/artist/")
	q := u.Query()
	q.Set("f", id)
	q.Set("skip_tracks", "true")
	u.RawQuery = q.Encode()
	var out struct {
		Albums struct {
			Items []apiAlbum `json:"items"`
		} `json:"albums"`
		Tracks []apiTrack `json:"tracks"`
	}
	if err := c.doHifiJSON(ctx, u.String(), &out); err != nil {
		return ArtistReleases{}, err
	}
	result := ArtistReleases{}
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
