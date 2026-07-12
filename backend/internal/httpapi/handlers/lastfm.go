package handlers

import (
	"errors"
	"net/http"

	"github.com/githubesson/lumen/internal/lastfm"
)

type LastFM struct{ Service *lastfm.Service }

type lastFMStatusResp struct {
	Configured bool   `json:"configured"`
	Connected  bool   `json:"connected"`
	Pending    bool   `json:"pending"`
	Username   string `json:"username,omitempty"`
	LastError  string `json:"last_error,omitempty"`
}

func (h *LastFM) Status(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	if h.Service == nil {
		writeJSON(w, http.StatusOK, lastFMStatusResp{})
		return
	}
	status, err := h.Service.Status(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, lastFMStatusResp{
		Configured: status.Configured,
		Connected:  status.Connected,
		Pending:    status.Pending,
		Username:   status.Username,
		LastError:  status.LastError,
	})
}

func (h *LastFM) Connect(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	if h.Service == nil || h.Service.Client == nil || !h.Service.Client.Configured() {
		http.Error(w, "last.fm is not configured", http.StatusServiceUnavailable)
		return
	}
	authorizationURL, err := h.Service.Begin(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "could not start Last.fm authorization", http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"authorization_url": authorizationURL})
}

func (h *LastFM) Complete(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	if h.Service == nil || h.Service.Client == nil || !h.Service.Client.Configured() {
		http.Error(w, "last.fm is not configured", http.StatusServiceUnavailable)
		return
	}
	username, err := h.Service.Complete(r.Context(), u.ID)
	if err != nil {
		var apiErr *lastfm.APIError
		if errors.As(err, &apiErr) && apiErr.Code == 14 {
			http.Error(w, "Last.fm authorization is not complete yet", http.StatusConflict)
			return
		}
		if errors.Is(err, lastfm.ErrNotConnected) {
			http.Error(w, "no Last.fm authorization is pending", http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"username": username})
}

func (h *LastFM) Disconnect(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	if h.Service == nil || h.Service.Store == nil {
		http.Error(w, "last.fm is not configured", http.StatusServiceUnavailable)
		return
	}
	if err := h.Service.Store.Disconnect(r.Context(), u.ID); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
