package handlers

import (
	"errors"
	"net/http"

	"github.com/githubesson/lumen/internal/tidal"
	"github.com/go-chi/chi/v5"
)

type AdminTIDAL struct {
	TIDAL *tidal.Client
}

type tidalStatusResp struct {
	Connected           bool            `json:"connected"`
	ProxyURL            string          `json:"proxy_url,omitempty"`
	CountryCode         string          `json:"country_code"`
	Quality             string          `json:"quality"`
	Version             string          `json:"version,omitempty"`
	Repo                string          `json:"repo,omitempty"`
	Error               string          `json:"error,omitempty"`
	ManagementSupported bool            `json:"management_supported"`
	ManagementError     string          `json:"management_error,omitempty"`
	Accounts            []tidal.Account `json:"accounts"`
}

func (h *AdminTIDAL) Status(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h.TIDAL == nil {
		writeJSON(w, http.StatusOK, tidalStatusResp{
			Connected: false,
			Accounts:  []tidal.Account{},
		})
		return
	}
	status, err := h.TIDAL.Status(r.Context())
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	accounts, accountsErr := h.TIDAL.Accounts(r.Context())
	managementSupported := accountsErr == nil
	managementError := ""
	accountList := []tidal.Account{}
	if accountsErr == nil {
		accountList = accounts.Accounts
	}
	if accountsErr != nil && !errors.Is(accountsErr, tidal.ErrManagementUnavailable) {
		managementError = "TIDAL account management is temporarily unavailable."
	}
	writeJSON(w, http.StatusOK, tidalStatusResp{
		Connected:           status.Connected,
		ProxyURL:            status.ProxyURL,
		CountryCode:         status.CountryCode,
		Quality:             status.Quality,
		Version:             status.Version,
		Repo:                status.Repo,
		Error:               status.Error,
		ManagementSupported: managementSupported,
		ManagementError:     managementError,
		Accounts:            accountList,
	})
}

func (h *AdminTIDAL) StartAuth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h.TIDAL == nil {
		http.Error(w, tidal.ErrNotConfigured.Error(), http.StatusServiceUnavailable)
		return
	}
	flow, err := h.TIDAL.StartDeviceAuth(r.Context())
	if err != nil {
		writeTIDALManagementError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, flow)
}

func (h *AdminTIDAL) PollAuth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h.TIDAL == nil {
		http.Error(w, tidal.ErrNotConfigured.Error(), http.StatusServiceUnavailable)
		return
	}
	result, err := h.TIDAL.PollDeviceAuth(r.Context(), chi.URLParam(r, "flowID"))
	if err != nil {
		writeTIDALManagementError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *AdminTIDAL) RemoveAccount(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h.TIDAL == nil {
		http.Error(w, tidal.ErrNotConfigured.Error(), http.StatusServiceUnavailable)
		return
	}
	if err := h.TIDAL.RemoveAccount(r.Context(), chi.URLParam(r, "accountID")); err != nil {
		writeTIDALManagementError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeTIDALManagementError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, tidal.ErrNotConfigured):
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
	case errors.Is(err, tidal.ErrManagementUnavailable):
		http.Error(w, err.Error(), http.StatusNotImplemented)
	case errors.Is(err, tidal.ErrAuthFlowNotFound), errors.Is(err, tidal.ErrAccountNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, tidal.ErrAccountNotRemovable):
		http.Error(w, err.Error(), http.StatusConflict)
	default:
		http.Error(w, "tidal account management failed", http.StatusBadGateway)
	}
}
