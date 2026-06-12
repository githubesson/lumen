package handlers

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/uncut/lumen/internal/filen"
	"github.com/uncut/lumen/internal/musicroots"
)

type AdminFilen struct {
	Store       *filen.Store
	MusicRoots  *musicroots.Store
	Scanner     *filen.Scanner
	PrimaryRoot string
}

type filenPinResp struct {
	ID                  uuid.UUID  `json:"id"`
	RootID              *uuid.UUID `json:"root_id,omitempty"`
	RootPath            string     `json:"root_path"`
	DestinationSubdir   string     `json:"destination_subdir"`
	DestinationPath     string     `json:"destination_path"`
	ShareURL            string     `json:"share_url"`
	PasswordSet         bool       `json:"password_set"`
	Label               string     `json:"label"`
	Enabled             bool       `json:"enabled"`
	ScanIntervalSeconds int        `json:"scan_interval_seconds"`
	LastScanAt          *time.Time `json:"last_scan_at,omitempty"`
	LastSuccessAt       *time.Time `json:"last_success_at,omitempty"`
	LastError           string     `json:"last_error,omitempty"`
	CreatedAt           time.Time  `json:"created_at"`
	UpdatedAt           time.Time  `json:"updated_at"`
	RootExists          bool       `json:"root_exists"`
}

type addFilenPinReq struct {
	RootID              string `json:"root_id"`
	RootPath            string `json:"root_path"`
	DestinationSubdir   string `json:"destination_subdir"`
	ShareURL            string `json:"share_url"`
	URL                 string `json:"url"`
	Password            string `json:"password"`
	Label               string `json:"label"`
	Enabled             *bool  `json:"enabled"`
	ScanIntervalSeconds int    `json:"scan_interval_seconds"`
}

type patchFilenPinReq struct {
	DestinationSubdir   *string `json:"destination_subdir"`
	Password            *string `json:"password"`
	Label               *string `json:"label"`
	Enabled             *bool   `json:"enabled"`
	ScanIntervalSeconds *int    `json:"scan_interval_seconds"`
}

func (h *AdminFilen) List(w http.ResponseWriter, r *http.Request) {
	listPins(w, r, h.Store.ListPins, h.pinResp)
}

func (h *AdminFilen) Add(w http.ResponseWriter, r *http.Request) {
	var req addFilenPinReq
	if !decodeJSON(w, r, &req) {
		return
	}
	rootID, rootPath, err := resolvePinRoot(r, h.MusicRoots, h.PrimaryRoot, req.RootID, req.RootPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	subdir, err := cleanPinSubdir(rootPath, req.DestinationSubdir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	shareURL := strings.TrimSpace(req.ShareURL)
	if shareURL == "" {
		shareURL = strings.TrimSpace(req.URL)
	}
	if shareURL == "" {
		http.Error(w, "share_url is required", http.StatusBadRequest)
		return
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	pin, err := h.Store.AddPin(r.Context(), filen.AddPinInput{
		RootID:              rootID,
		RootPath:            rootPath,
		DestinationSubdir:   subdir,
		ShareURL:            shareURL,
		Password:            req.Password,
		Label:               strings.TrimSpace(req.Label),
		Enabled:             enabled,
		ScanIntervalSeconds: req.ScanIntervalSeconds,
	})
	if err != nil {
		writePinAddError(w, err, "already pinned", "scan_interval")
		return
	}
	writeJSON(w, http.StatusCreated, h.pinResp(pin))
}

func (h *AdminFilen) Patch(w http.ResponseWriter, r *http.Request) {
	id, ok := pathPinID(w, r)
	if !ok {
		return
	}
	var req patchFilenPinReq
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.DestinationSubdir == nil && req.Password == nil && req.Label == nil &&
		req.Enabled == nil && req.ScanIntervalSeconds == nil {
		http.Error(w, "nothing to update", http.StatusBadRequest)
		return
	}
	if !resolvePatchSubdir(w, r, id, filen.ErrNotFound, h.pinRootPath, &req.DestinationSubdir) {
		return
	}
	cleanStringPtr(req.Password)
	cleanStringPtr(req.Label)
	pin, err := h.Store.PatchPin(r.Context(), id, filen.PatchPinInput{
		DestinationSubdir:   req.DestinationSubdir,
		Password:            req.Password,
		Label:               req.Label,
		Enabled:             req.Enabled,
		ScanIntervalSeconds: req.ScanIntervalSeconds,
	})
	if err != nil {
		if errors.Is(err, filen.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, h.pinResp(pin))
}

func (h *AdminFilen) Delete(w http.ResponseWriter, r *http.Request) {
	deletePin(w, r, filen.ErrNotFound, h.Store.DeletePin)
}

func (h *AdminFilen) Scan(w http.ResponseWriter, r *http.Request) {
	var start func(context.Context, uuid.UUID) (bool, error)
	if h.Scanner != nil {
		start = h.Scanner.StartPinScan
	}
	scanPinNow(w, r, filen.ErrNotFound, start)
}

func (h *AdminFilen) Downloads(w http.ResponseWriter, r *http.Request) {
	listPinDownloads(w, r, h.Store.ListDownloads)
}

func (h *AdminFilen) pinRootPath(ctx context.Context, id uuid.UUID) (string, error) {
	pin, err := h.Store.GetPin(ctx, id)
	return pin.RootPath, err
}

func (h *AdminFilen) pinResp(pin filen.Pin) filenPinResp {
	dest, _ := filepath.Abs(filepath.Join(pin.RootPath, pin.DestinationSubdir))
	return filenPinResp{
		ID:                  pin.ID,
		RootID:              pin.RootID,
		RootPath:            pin.RootPath,
		DestinationSubdir:   pin.DestinationSubdir,
		DestinationPath:     dest,
		ShareURL:            pin.ShareURL,
		PasswordSet:         strings.TrimSpace(pin.Password) != "",
		Label:               pin.Label,
		Enabled:             pin.Enabled,
		ScanIntervalSeconds: pin.ScanIntervalSeconds,
		LastScanAt:          pin.LastScanAt,
		LastSuccessAt:       pin.LastSuccessAt,
		LastError:           pin.LastError,
		CreatedAt:           pin.CreatedAt,
		UpdatedAt:           pin.UpdatedAt,
		RootExists:          dirExists(pin.RootPath),
	}
}
