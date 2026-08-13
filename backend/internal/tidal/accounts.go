package tidal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/githubesson/lumen/internal/httpx"
)

var (
	ErrManagementUnavailable = errors.New("tidal account management is unavailable")
	ErrAuthFlowNotFound      = errors.New("tidal sign-in was not found")
	ErrAccountNotFound       = errors.New("tidal account was not found")
	ErrAccountNotRemovable   = errors.New("tidal account is configured through the environment")
)

type Account struct {
	ID        string `json:"id"`
	UserID    string `json:"user_id"`
	Removable bool   `json:"removable"`
}

type Accounts struct {
	Accounts []Account `json:"accounts"`
}

type DeviceAuthStart struct {
	FlowID          string    `json:"flow_id"`
	VerificationURL string    `json:"verification_url"`
	UserCode        string    `json:"user_code,omitempty"`
	ExpiresAt       time.Time `json:"expires_at"`
}

type DeviceAuthPoll struct {
	State   string   `json:"state"`
	Message string   `json:"message,omitempty"`
	Account *Account `json:"account,omitempty"`
}

func (c *Client) Accounts(ctx context.Context) (Accounts, error) {
	var out Accounts
	if err := c.doManagementJSON(ctx, http.MethodGet, "/lumen/accounts", &out); err != nil {
		if managementStatus(err) == http.StatusNotFound {
			return Accounts{}, ErrManagementUnavailable
		}
		return Accounts{}, err
	}
	if out.Accounts == nil {
		out.Accounts = []Account{}
	}
	return out, nil
}

func (c *Client) StartDeviceAuth(ctx context.Context) (DeviceAuthStart, error) {
	var out DeviceAuthStart
	if err := c.doManagementJSON(ctx, http.MethodPost, "/lumen/auth/device", &out); err != nil {
		if managementStatus(err) == http.StatusNotFound {
			return DeviceAuthStart{}, ErrManagementUnavailable
		}
		return DeviceAuthStart{}, err
	}
	return out, nil
}

func (c *Client) PollDeviceAuth(ctx context.Context, flowID string) (DeviceAuthPoll, error) {
	flowID = strings.TrimSpace(flowID)
	if flowID == "" {
		return DeviceAuthPoll{}, ErrAuthFlowNotFound
	}
	var out DeviceAuthPoll
	path := "/lumen/auth/device/" + url.PathEscape(flowID)
	if err := c.doManagementJSON(ctx, http.MethodGet, path, &out); err != nil {
		if managementStatus(err) == http.StatusNotFound {
			return DeviceAuthPoll{}, ErrAuthFlowNotFound
		}
		return DeviceAuthPoll{}, err
	}
	return out, nil
}

func (c *Client) RemoveAccount(ctx context.Context, accountID string) error {
	accountID = strings.TrimSpace(accountID)
	if accountID == "" {
		return ErrAccountNotFound
	}
	var out struct {
		Removed bool `json:"removed"`
	}
	path := "/lumen/accounts/" + url.PathEscape(accountID)
	if err := c.doManagementJSON(ctx, http.MethodDelete, path, &out); err != nil {
		switch managementStatus(err) {
		case http.StatusNotFound:
			return ErrAccountNotFound
		case http.StatusConflict:
			return ErrAccountNotRemovable
		}
		return err
	}
	return nil
}

type managementHTTPError struct {
	status int
	body   string
}

func (e *managementHTTPError) Error() string {
	return fmt.Sprintf("hifi-api account request failed: status %d: %s", e.status, e.body)
}

func managementStatus(err error) int {
	var target *managementHTTPError
	if errors.As(err, &target) {
		return target.status
	}
	return 0
}

func (c *Client) doManagementJSON(ctx context.Context, method, path string, dst any) error {
	if strings.TrimSpace(c.cfg.HifiAPIURL) == "" {
		return ErrNotConfigured
	}
	req, err := http.NewRequestWithContext(ctx, method, c.hifiURL(path).String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", httpx.BrowserUserAgent)
	resp, err := c.api.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		message := strings.TrimSpace(string(body))
		var detail struct {
			Detail string `json:"detail"`
		}
		if json.Unmarshal(body, &detail) == nil && detail.Detail != "" {
			message = detail.Detail
		}
		return &managementHTTPError{status: resp.StatusCode, body: message}
	}
	return json.NewDecoder(resp.Body).Decode(dst)
}
