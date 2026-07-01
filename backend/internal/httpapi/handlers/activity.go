package handlers

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/githubesson/lumen/internal/activity"
)

const playbackActivityMaxAge = 60 * time.Second

type Activity struct {
	Store *activity.Store
}

type playbackActivityReq struct {
	DeviceID    string `json:"device_id"`
	DeviceName  string `json:"device_name"`
	TrackID     string `json:"track_id"`
	Title       string `json:"title"`
	Artist      string `json:"artist,omitempty"`
	Album       string `json:"album,omitempty"`
	AlbumID     string `json:"album_id,omitempty"`
	CoverURL    string `json:"cover_url,omitempty"`
	DurationSec int    `json:"duration_sec,omitempty"`
	PositionSec int    `json:"position_sec"`
	IsPlaying   bool   `json:"is_playing"`
}

type playbackActivityResp struct {
	DeviceID    string `json:"device_id"`
	DeviceName  string `json:"device_name"`
	TrackID     string `json:"track_id"`
	Title       string `json:"title"`
	Artist      string `json:"artist,omitempty"`
	Album       string `json:"album,omitempty"`
	AlbumID     string `json:"album_id,omitempty"`
	CoverURL    string `json:"cover_url,omitempty"`
	DurationSec int    `json:"duration_sec,omitempty"`
	PositionSec int    `json:"position_sec"`
	IsPlaying   bool   `json:"is_playing"`
	UpdatedAt   string `json:"updated_at"`
}

type currentPlaybackActivityResp struct {
	Activity *playbackActivityResp `json:"activity"`
}

func (h *Activity) Upsert(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	var req playbackActivityReq
	if !decodeJSON(w, r, &req) {
		return
	}
	out, err := h.Store.Upsert(r.Context(), activity.UpsertInput{
		UserID:      u.ID,
		DeviceID:    req.DeviceID,
		DeviceName:  req.DeviceName,
		TrackID:     req.TrackID,
		Title:       req.Title,
		Artist:      req.Artist,
		Album:       req.Album,
		AlbumID:     req.AlbumID,
		CoverURL:    req.CoverURL,
		DurationSec: req.DurationSec,
		PositionSec: req.PositionSec,
		IsPlaying:   req.IsPlaying,
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, toPlaybackActivityResp(out))
}

func (h *Activity) Current(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	out, err := h.Store.Current(
		r.Context(),
		u.ID,
		r.URL.Query().Get("exclude_device_id"),
		playbackActivityMaxAge,
	)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, currentPlaybackActivityResp{
		Activity: toPlaybackActivityResp(out),
	})
}

func (h *Activity) Delete(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	if err := h.Store.Delete(r.Context(), u.ID, chi.URLParam(r, "device_id")); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func toPlaybackActivityResp(a *activity.Activity) *playbackActivityResp {
	if a == nil {
		return nil
	}
	return &playbackActivityResp{
		DeviceID:    a.DeviceID,
		DeviceName:  a.DeviceName,
		TrackID:     a.TrackID,
		Title:       a.Title,
		Artist:      a.Artist,
		Album:       a.Album,
		AlbumID:     a.AlbumID,
		CoverURL:    a.CoverURL,
		DurationSec: a.DurationSec,
		PositionSec: a.PositionSec,
		IsPlaying:   a.IsPlaying,
		UpdatedAt:   a.UpdatedAt.Format(time.RFC3339Nano),
	}
}
