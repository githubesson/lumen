package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/githubesson/lumen/internal/tidal"
)

func TestAdminTIDALStatusIncludesManagedAccounts(t *testing.T) {
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/":
			_, _ = w.Write([]byte(`{"version":"2.10","Repo":"https://github.com/binimum/hifi-api"}`))
		case "/lumen/accounts":
			_, _ = w.Write([]byte(`{"accounts":[{"id":"account-1","user_id":"42","removable":true}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer sidecar.Close()

	handler := &AdminTIDAL{TIDAL: tidal.NewClient(tidal.Config{
		HifiAPIURL:  sidecar.URL,
		CountryCode: "PL",
		Quality:     "LOSSLESS",
	})}
	recorder := httptest.NewRecorder()
	handler.Status(recorder, httptest.NewRequest(http.MethodGet, "/api/admin/tidal/status", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response tidalStatusResp
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if !response.Connected || !response.ManagementSupported {
		t.Fatalf("status response = %#v", response)
	}
	if response.CountryCode != "PL" || len(response.Accounts) != 1 || response.Accounts[0].UserID != "42" {
		t.Fatalf("status response = %#v", response)
	}
}

func TestAdminTIDALStatusGracefullyHandlesStockSidecar(t *testing.T) {
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/" {
			_, _ = w.Write([]byte(`{"version":"2.10"}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer sidecar.Close()

	handler := &AdminTIDAL{TIDAL: tidal.NewClient(tidal.Config{HifiAPIURL: sidecar.URL})}
	recorder := httptest.NewRecorder()
	handler.Status(recorder, httptest.NewRequest(http.MethodGet, "/api/admin/tidal/status", nil))

	var response tidalStatusResp
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if response.ManagementSupported || response.Accounts == nil || len(response.Accounts) != 0 {
		t.Fatalf("status response = %#v", response)
	}
}
