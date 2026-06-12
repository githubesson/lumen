package handlers

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/artistgrid"
	"github.com/githubesson/lumen/internal/musicroots"
)

type AdminArtistGrid struct {
	Store       *artistgrid.Store
	MusicRoots  *musicroots.Store
	Scanner     *artistgrid.Scanner
	PrimaryRoot string
}

type artistGridPinResp struct {
	ID                  uuid.UUID  `json:"id"`
	RootID              *uuid.UUID `json:"root_id,omitempty"`
	RootPath            string     `json:"root_path"`
	DestinationSubdir   string     `json:"destination_subdir"`
	DestinationPath     string     `json:"destination_path"`
	TrackerID           string     `json:"tracker_id"`
	TrackerURL          string     `json:"tracker_url"`
	Tab                 string     `json:"tab"`
	Label               string     `json:"label"`
	PrimaryArtist       string     `json:"primary_artist"`
	Enabled             bool       `json:"enabled"`
	ScanIntervalSeconds int        `json:"scan_interval_seconds"`
	LastScanAt          *time.Time `json:"last_scan_at,omitempty"`
	LastSuccessAt       *time.Time `json:"last_success_at,omitempty"`
	LastError           string     `json:"last_error,omitempty"`
	CreatedAt           time.Time  `json:"created_at"`
	UpdatedAt           time.Time  `json:"updated_at"`
	RootExists          bool       `json:"root_exists"`
}

type addArtistGridPinReq struct {
	RootID              string `json:"root_id"`
	RootPath            string `json:"root_path"`
	DestinationSubdir   string `json:"destination_subdir"`
	Tracker             string `json:"tracker"`
	TrackerID           string `json:"tracker_id"`
	TrackerURL          string `json:"tracker_url"`
	Tab                 string `json:"tab"`
	Label               string `json:"label"`
	PrimaryArtist       string `json:"primary_artist"`
	Enabled             *bool  `json:"enabled"`
	ScanIntervalSeconds int    `json:"scan_interval_seconds"`
}

type patchArtistGridPinReq struct {
	DestinationSubdir   *string `json:"destination_subdir"`
	Tab                 *string `json:"tab"`
	Label               *string `json:"label"`
	PrimaryArtist       *string `json:"primary_artist"`
	Enabled             *bool   `json:"enabled"`
	ScanIntervalSeconds *int    `json:"scan_interval_seconds"`
}

func (h *AdminArtistGrid) List(w http.ResponseWriter, r *http.Request) {
	listPins(w, r, h.Store.ListPins, h.pinResp)
}

func (h *AdminArtistGrid) Add(w http.ResponseWriter, r *http.Request) {
	var req addArtistGridPinReq
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
	trackerRaw := strings.TrimSpace(req.Tracker)
	if trackerRaw == "" {
		trackerRaw = strings.TrimSpace(req.TrackerURL)
	}
	if trackerRaw == "" {
		trackerRaw = strings.TrimSpace(req.TrackerID)
	}
	trackerID := artistgrid.ExtractTrackerID(trackerRaw)
	if !artistgrid.ValidTrackerID(trackerID) {
		http.Error(w, "tracker id not found in ArtistGrid URL", http.StatusBadRequest)
		return
	}
	trackerURL := strings.TrimSpace(req.TrackerURL)
	if trackerURL == "" && strings.Contains(trackerRaw, "://") {
		trackerURL = trackerRaw
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	pin, err := h.Store.AddPin(r.Context(), artistgrid.AddPinInput{
		RootID:              rootID,
		RootPath:            rootPath,
		DestinationSubdir:   subdir,
		TrackerID:           trackerID,
		TrackerURL:          trackerURL,
		Tab:                 strings.TrimSpace(req.Tab),
		Label:               strings.TrimSpace(req.Label),
		PrimaryArtist:       strings.TrimSpace(req.PrimaryArtist),
		Enabled:             enabled,
		ScanIntervalSeconds: req.ScanIntervalSeconds,
	})
	if err != nil {
		writePinAddError(w, err, "already pinned", "scan_interval")
		return
	}
	writeJSON(w, http.StatusCreated, h.pinResp(pin))
}

func (h *AdminArtistGrid) Patch(w http.ResponseWriter, r *http.Request) {
	id, ok := pathPinID(w, r)
	if !ok {
		return
	}
	var req patchArtistGridPinReq
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.DestinationSubdir == nil && req.Tab == nil && req.Label == nil &&
		req.PrimaryArtist == nil && req.Enabled == nil && req.ScanIntervalSeconds == nil {
		http.Error(w, "nothing to update", http.StatusBadRequest)
		return
	}
	if !resolvePatchSubdir(w, r, id, artistgrid.ErrNotFound, h.pinRootPath, &req.DestinationSubdir) {
		return
	}
	cleanStringPtr(req.Tab)
	cleanStringPtr(req.Label)
	cleanStringPtr(req.PrimaryArtist)
	pin, err := h.Store.PatchPin(r.Context(), id, artistgrid.PatchPinInput{
		DestinationSubdir:   req.DestinationSubdir,
		Tab:                 req.Tab,
		Label:               req.Label,
		PrimaryArtist:       req.PrimaryArtist,
		Enabled:             req.Enabled,
		ScanIntervalSeconds: req.ScanIntervalSeconds,
	})
	if err != nil {
		if errors.Is(err, artistgrid.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, h.pinResp(pin))
}

func (h *AdminArtistGrid) Delete(w http.ResponseWriter, r *http.Request) {
	deletePin(w, r, artistgrid.ErrNotFound, h.Store.DeletePin)
}

func (h *AdminArtistGrid) Scan(w http.ResponseWriter, r *http.Request) {
	var start func(context.Context, uuid.UUID) (bool, error)
	if h.Scanner != nil {
		start = h.Scanner.StartPinScan
	}
	scanPinNow(w, r, artistgrid.ErrNotFound, start)
}

func (h *AdminArtistGrid) Downloads(w http.ResponseWriter, r *http.Request) {
	listPinDownloads(w, r, h.Store.ListDownloads)
}

func (h *AdminArtistGrid) pinRootPath(ctx context.Context, id uuid.UUID) (string, error) {
	pin, err := h.Store.GetPin(ctx, id)
	return pin.RootPath, err
}

func (h *AdminArtistGrid) pinResp(pin artistgrid.Pin) artistGridPinResp {
	dest, _ := filepath.Abs(filepath.Join(pin.RootPath, pin.DestinationSubdir))
	return artistGridPinResp{
		ID:                  pin.ID,
		RootID:              pin.RootID,
		RootPath:            pin.RootPath,
		DestinationSubdir:   pin.DestinationSubdir,
		DestinationPath:     dest,
		TrackerID:           pin.TrackerID,
		TrackerURL:          pin.TrackerURL,
		Tab:                 pin.Tab,
		Label:               pin.Label,
		PrimaryArtist:       pin.PrimaryArtist,
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
