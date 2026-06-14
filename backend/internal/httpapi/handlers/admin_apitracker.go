package handlers

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/apitracker"
	"github.com/githubesson/lumen/internal/musicroots"
)

type AdminAPITracker struct {
	Store       *apitracker.Store
	MusicRoots  *musicroots.Store
	Scanner     *apitracker.Scanner
	PrimaryRoot string
}

type apiTrackerPinResp struct {
	ID                  uuid.UUID  `json:"id"`
	RootID              *uuid.UUID `json:"root_id,omitempty"`
	RootPath            string     `json:"root_path"`
	DestinationSubdir   string     `json:"destination_subdir"`
	DestinationPath     string     `json:"destination_path"`
	APIBaseURL          string     `json:"api_base_url"`
	TrackerID           int64      `json:"tracker_id"`
	TrackerName         string     `json:"tracker_name"`
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

type addAPITrackerPinReq struct {
	RootID              string       `json:"root_id"`
	RootPath            string       `json:"root_path"`
	DestinationSubdir   string       `json:"destination_subdir"`
	APIBaseURL          string       `json:"api_base_url"`
	Tracker             string       `json:"tracker"`
	TrackerID           flexibleID64 `json:"tracker_id"`
	TrackerURL          string       `json:"tracker_url"`
	TrackerName         string       `json:"tracker_name"`
	Tab                 string       `json:"tab"`
	Label               string       `json:"label"`
	PrimaryArtist       string       `json:"primary_artist"`
	Enabled             *bool        `json:"enabled"`
	ScanIntervalSeconds int          `json:"scan_interval_seconds"`
}

type patchAPITrackerPinReq struct {
	DestinationSubdir   *string `json:"destination_subdir"`
	Tab                 *string `json:"tab"`
	Label               *string `json:"label"`
	PrimaryArtist       *string `json:"primary_artist"`
	Enabled             *bool   `json:"enabled"`
	ScanIntervalSeconds *int    `json:"scan_interval_seconds"`
}

type flexibleID64 struct {
	Value int64
}

func (id *flexibleID64) UnmarshalJSON(b []byte) error {
	raw := strings.TrimSpace(string(b))
	if raw == "" || raw == "null" {
		return nil
	}
	raw = strings.Trim(raw, `"`)
	if raw == "" {
		return nil
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return err
	}
	id.Value = v
	return nil
}

func (id flexibleID64) String() string {
	if id.Value <= 0 {
		return ""
	}
	return strconv.FormatInt(id.Value, 10)
}

func (h *AdminAPITracker) List(w http.ResponseWriter, r *http.Request) {
	listPins(w, r, h.Store.ListPins, h.pinResp)
}

func (h *AdminAPITracker) Add(w http.ResponseWriter, r *http.Request) {
	var req addAPITrackerPinReq
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
		trackerRaw = req.TrackerID.String()
	}
	trackerID := req.TrackerID.Value
	if trackerID <= 0 {
		trackerID = apitracker.ExtractTrackerID(trackerRaw)
	}
	if trackerID <= 0 {
		http.Error(w, "tracker_id not found in Tracker API URL", http.StatusBadRequest)
		return
	}
	apiBaseURL := strings.TrimSpace(req.APIBaseURL)
	if apiBaseURL == "" {
		apiBaseURL = apitracker.ExtractBaseURL(req.TrackerURL)
	}
	apiBaseURL = apitracker.NormalizeBaseURL(apiBaseURL)
	trackerURL := strings.TrimSpace(req.TrackerURL)
	if trackerURL == "" && strings.Contains(trackerRaw, "://") {
		trackerURL = trackerRaw
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	pin, err := h.Store.AddPin(r.Context(), apitracker.AddPinInput{
		RootID:              rootID,
		RootPath:            rootPath,
		DestinationSubdir:   subdir,
		APIBaseURL:          apiBaseURL,
		TrackerID:           trackerID,
		TrackerName:         strings.TrimSpace(req.TrackerName),
		TrackerURL:          trackerURL,
		Tab:                 strings.TrimSpace(req.Tab),
		Label:               strings.TrimSpace(req.Label),
		PrimaryArtist:       strings.TrimSpace(req.PrimaryArtist),
		Enabled:             enabled,
		ScanIntervalSeconds: req.ScanIntervalSeconds,
	})
	if err != nil {
		writePinAddError(w, err, "already pinned", "scan_interval", "tracker_id")
		return
	}
	writeJSON(w, http.StatusCreated, h.pinResp(pin))
}

func (h *AdminAPITracker) Patch(w http.ResponseWriter, r *http.Request) {
	id, ok := pathPinID(w, r)
	if !ok {
		return
	}
	var req patchAPITrackerPinReq
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.DestinationSubdir == nil && req.Tab == nil && req.Label == nil &&
		req.PrimaryArtist == nil && req.Enabled == nil && req.ScanIntervalSeconds == nil {
		http.Error(w, "nothing to update", http.StatusBadRequest)
		return
	}
	if !resolvePatchSubdir(w, r, id, apitracker.ErrNotFound, h.pinRootPath, &req.DestinationSubdir) {
		return
	}
	cleanStringPtr(req.Tab)
	cleanStringPtr(req.Label)
	cleanStringPtr(req.PrimaryArtist)
	pin, err := h.Store.PatchPin(r.Context(), id, apitracker.PatchPinInput{
		DestinationSubdir:   req.DestinationSubdir,
		Tab:                 req.Tab,
		Label:               req.Label,
		PrimaryArtist:       req.PrimaryArtist,
		Enabled:             req.Enabled,
		ScanIntervalSeconds: req.ScanIntervalSeconds,
	})
	if err != nil {
		if errors.Is(err, apitracker.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, h.pinResp(pin))
}

func (h *AdminAPITracker) Delete(w http.ResponseWriter, r *http.Request) {
	deletePin(w, r, apitracker.ErrNotFound, h.Store.DeletePin)
}

func (h *AdminAPITracker) Scan(w http.ResponseWriter, r *http.Request) {
	var start func(context.Context, uuid.UUID) (bool, error)
	if h.Scanner != nil {
		start = h.Scanner.StartPinScan
	}
	scanPinNow(w, r, apitracker.ErrNotFound, start)
}

func (h *AdminAPITracker) Downloads(w http.ResponseWriter, r *http.Request) {
	listPinDownloads(w, r, h.Store.ListDownloads)
}

func (h *AdminAPITracker) pinRootPath(ctx context.Context, id uuid.UUID) (string, error) {
	pin, err := h.Store.GetPin(ctx, id)
	return pin.RootPath, err
}

func (h *AdminAPITracker) pinResp(pin apitracker.Pin) apiTrackerPinResp {
	dest, _ := filepath.Abs(filepath.Join(pin.RootPath, pin.DestinationSubdir))
	return apiTrackerPinResp{
		ID:                  pin.ID,
		RootID:              pin.RootID,
		RootPath:            pin.RootPath,
		DestinationSubdir:   pin.DestinationSubdir,
		DestinationPath:     dest,
		APIBaseURL:          pin.APIBaseURL,
		TrackerID:           pin.TrackerID,
		TrackerName:         pin.TrackerName,
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
