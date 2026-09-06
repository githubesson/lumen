package tidal

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAccountManagementRequests(t *testing.T) {
	t.Helper()
	var removedPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/lumen/accounts":
			_, _ = w.Write([]byte(`{"accounts":[{"id":"account-1","user_id":"42","removable":true}]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/lumen/auth/device":
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"flow_id":"flow-1","verification_url":"https://link.tidal.com/test","expires_at":"2026-08-13T12:00:00Z"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/lumen/auth/device/flow-1":
			_, _ = w.Write([]byte(`{"state":"linked","account":{"id":"account-1","user_id":"42","removable":true}}`))
		case r.Method == http.MethodDelete:
			removedPath = r.URL.Path
			_, _ = w.Write([]byte(`{"removed":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	client := NewClient(Config{HifiAPIURL: srv.URL})
	accounts, err := client.Accounts(context.Background())
	if err != nil {
		t.Fatalf("Accounts returned error: %v", err)
	}
	if len(accounts.Accounts) != 1 || accounts.Accounts[0].UserID != "42" || !accounts.Accounts[0].Removable {
		t.Fatalf("Accounts = %#v", accounts.Accounts)
	}

	flow, err := client.StartDeviceAuth(context.Background())
	if err != nil {
		t.Fatalf("StartDeviceAuth returned error: %v", err)
	}
	if flow.FlowID != "flow-1" || flow.VerificationURL != "https://link.tidal.com/test" || flow.ExpiresAt.IsZero() {
		t.Fatalf("StartDeviceAuth = %#v", flow)
	}

	poll, err := client.PollDeviceAuth(context.Background(), flow.FlowID)
	if err != nil {
		t.Fatalf("PollDeviceAuth returned error: %v", err)
	}
	if poll.State != "linked" || poll.Account == nil || poll.Account.ID != "account-1" {
		t.Fatalf("PollDeviceAuth = %#v", poll)
	}

	if err := client.RemoveAccount(context.Background(), "account-1"); err != nil {
		t.Fatalf("RemoveAccount returned error: %v", err)
	}
	if removedPath != "/lumen/accounts/account-1" {
		t.Fatalf("remove path = %q", removedPath)
	}
}

func TestAccountManagementMapsMissingExtensionAndResources(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	client := NewClient(Config{HifiAPIURL: srv.URL})

	if _, err := client.Accounts(context.Background()); !errors.Is(err, ErrManagementUnavailable) {
		t.Fatalf("Accounts error = %v, want ErrManagementUnavailable", err)
	}
	if _, err := client.StartDeviceAuth(context.Background()); !errors.Is(err, ErrManagementUnavailable) {
		t.Fatalf("StartDeviceAuth error = %v, want ErrManagementUnavailable", err)
	}
	if _, err := client.PollDeviceAuth(context.Background(), "missing"); !errors.Is(err, ErrAuthFlowNotFound) {
		t.Fatalf("PollDeviceAuth error = %v, want ErrAuthFlowNotFound", err)
	}
	if err := client.RemoveAccount(context.Background(), "missing"); !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("RemoveAccount error = %v, want ErrAccountNotFound", err)
	}
}

func TestRemoveEnvironmentAccountMapsConflict(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"detail":"configured through environment"}`))
	}))
	defer srv.Close()

	client := NewClient(Config{HifiAPIURL: srv.URL})
	if err := client.RemoveAccount(context.Background(), "env-account"); !errors.Is(err, ErrAccountNotRemovable) {
		t.Fatalf("RemoveAccount error = %v, want ErrAccountNotRemovable", err)
	}
}
