package handlers

import (
	"net/http"

	"github.com/githubesson/lumen/internal/tidal"
)

type AdminTIDAL struct {
	TIDAL *tidal.Client
}

type tidalStatusResp struct {
	Connected   bool   `json:"connected"`
	ProxyURL    string `json:"proxy_url,omitempty"`
	CountryCode string `json:"country_code"`
	Quality     string `json:"quality"`
	Version     string `json:"version,omitempty"`
	Repo        string `json:"repo,omitempty"`
	Error       string `json:"error,omitempty"`
}

func (h *AdminTIDAL) Status(w http.ResponseWriter, r *http.Request) {
	if h.TIDAL == nil {
		writeJSON(w, http.StatusOK, tidalStatusResp{Connected: false})
		return
	}
	status, err := h.TIDAL.Status(r.Context())
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, tidalStatusResp{
		Connected:   status.Connected,
		ProxyURL:    status.ProxyURL,
		CountryCode: status.CountryCode,
		Quality:     status.Quality,
		Version:     status.Version,
		Repo:        status.Repo,
		Error:       status.Error,
	})
}
