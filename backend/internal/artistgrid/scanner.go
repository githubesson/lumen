package artistgrid

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/downloadfile"
	"github.com/githubesson/lumen/internal/httpx"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/pathsafe"
	"github.com/githubesson/lumen/internal/pinscan"
	"github.com/githubesson/lumen/internal/sourceurl"
)

// Fallback per-file download deadline when *_FILE_TIMEOUT is unset or <= 0.
const defaultFileTimeout = 30 * time.Minute

type Scanner struct {
	Store        *Store
	Client       *Client
	Ingest       *ingest.Service
	Library      *library.Store
	Logger       *slog.Logger
	PollInterval time.Duration
	FileTimeout  time.Duration

	downloadHTTP      *http.Client
	downloadURLPolicy httpx.DownloadPolicy

	scans pinscan.Group
}

type ScanSummary struct {
	PinID      uuid.UUID `json:"pin_id"`
	TrackerID  string    `json:"tracker_id"`
	Tab        string    `json:"tab"`
	Seen       int       `json:"seen"`
	NoURL      int       `json:"no_url"`
	Downloaded int       `json:"downloaded"`
	Existing   int       `json:"existing"`
	Skipped    int       `json:"skipped"`
	Failed     int       `json:"failed"`
	Ingested   int       `json:"ingested"`
}

func (s *Scanner) Run(ctx context.Context) {
	if s == nil || s.Store == nil {
		return
	}
	pinscan.Run(ctx, s.PollInterval, s.scanDue)
}

func (s *Scanner) StartPinScan(ctx context.Context, id uuid.UUID) (bool, error) {
	if !s.scans.TryBegin(id) {
		return false, nil
	}
	pin, err := s.Store.GetPin(ctx, id)
	if err != nil {
		s.scans.End(id)
		return false, err
	}
	s.scans.Go(id, "artistgrid manual scan", func() {
		_, err := s.ScanPin(ctx, pin)
		if err != nil && s.Logger != nil {
			s.Logger.Warn("artistgrid manual scan failed", "pin", id, "err", err)
		}
	})
	return true, nil
}

func (s *Scanner) scanDue(ctx context.Context) {
	pins, err := s.Store.DuePins(ctx, pinscan.DefaultScanBatch)
	if err != nil {
		if s.Logger != nil && !errors.Is(err, context.Canceled) {
			s.Logger.Warn("artistgrid due pins fetch failed", "err", err)
		}
		return
	}
	for _, pin := range pins {
		if !s.scans.TryBegin(pin.ID) {
			continue
		}
		s.scans.Go(pin.ID, "artistgrid scheduled scan", func() {
			_, err := s.ScanPin(ctx, pin)
			if err != nil && s.Logger != nil {
				s.Logger.Warn("artistgrid scheduled scan failed", "pin", pin.ID, "tracker", pin.TrackerID, "err", err)
			}
		})
	}
}

// Wait blocks until all scheduled and manually-triggered scans have stopped.
// Call it after Run has returned so no new jobs can be added.
func (s *Scanner) Wait() { s.scans.Wait() }

func (s *Scanner) ScanPin(ctx context.Context, pin Pin) (ScanSummary, error) {
	trackerID := s.trackerIDForPin(ctx, &pin)
	summary := ScanSummary{PinID: pin.ID, TrackerID: trackerID}
	if err := s.Store.MarkScanStarted(ctx, pin.ID); err != nil {
		return summary, err
	}
	scanErr := s.scanPin(ctx, pin, &summary)
	if err := s.Store.MarkScanFinished(ctx, pin.ID, scanErr); err != nil && scanErr == nil {
		scanErr = err
	}
	return summary, scanErr
}

// client and fileTimeout read the configured values, falling back to defaults
// without writing them back. ScanPin runs concurrently (scanDue fans out one
// goroutine per due pin while StartPinScan adds more from the admin handler),
// so lazily initialising the shared fields was an unsynchronized write to
// state other goroutines read.
func (s *Scanner) client() *Client {
	if s.Client != nil {
		return s.Client
	}
	return NewClient()
}

func (s *Scanner) fileTimeout() time.Duration {
	if s.FileTimeout > 0 {
		return s.FileTimeout
	}
	return defaultFileTimeout
}

func (s *Scanner) trackerIDForPin(ctx context.Context, pin *Pin) string {
	if ValidTrackerID(pin.TrackerID) {
		return pin.TrackerID
	}
	trackerID := ExtractTrackerID(pin.TrackerURL)
	if !ValidTrackerID(trackerID) {
		return pin.TrackerID
	}
	if trackerID != pin.TrackerID {
		if err := s.Store.SetPinTrackerID(ctx, pin.ID, trackerID); err != nil && s.Logger != nil {
			s.Logger.Warn("artistgrid tracker id repair failed", "pin", pin.ID, "tracker", trackerID, "err", err)
		}
		pin.TrackerID = trackerID
	}
	return trackerID
}

func (s *Scanner) scanPin(ctx context.Context, pin Pin, summary *ScanSummary) error {
	destBase, err := pinDestination(pin)
	if err != nil {
		return err
	}
	data, err := s.client().Fetch(ctx, pin.TrackerID, pin.Tab)
	if err != nil {
		return err
	}
	tab := strings.TrimSpace(pin.Tab)
	if tab == "" {
		tab = strings.TrimSpace(data.CurrentTab)
	}
	if tab == "" && len(data.Tabs) > 0 {
		tab = data.Tabs[0]
	}
	summary.Tab = tab

	records := data.Records()
	for _, rec := range records {
		if len(rec.URLs) == 0 {
			summary.NoURL++
			continue
		}
		ctxMeta := BuildContext(data, pin, tab, rec)
		sourceURLs := s.expandRecordURLs(ctx, rec.URLs)
		for i, sourceURL := range sourceURLs {
			sourceURL = strings.TrimSpace(sourceURL)
			if sourceURL == "" {
				summary.NoURL++
				continue
			}
			summary.Seen++
			fallback := downloadfile.SanitizeName(rec.ItemName)
			if len(sourceURLs) > 1 {
				fallback = fmt.Sprintf("%s_%d", fallback, i+1)
			}
			metadata := recordMetadata(data, pin, tab, rec, ctxMeta)
			if sourceurl.ShouldSkipURL(sourceURL) {
				summary.Skipped++
				_ = s.Store.RecordDownload(ctx, DownloadInput{
					PinID:     pin.ID,
					SourceURL: sourceURL,
					Status:    StatusSkipped,
					Error:     "skipped host",
					Metadata:  metadata,
				})
				continue
			}
			if s.previousStillPresent(ctx, pin.ID, sourceURL, summary) {
				continue
			}
			status, resolvedURL, filePath, trackID, ingestInserted, err := s.downloadOne(
				ctx, pin, destBase, rec, fallback, sourceURL, ctxMeta,
			)
			if err != nil {
				var skipErr downloadfile.SkipError
				if errors.As(err, &skipErr) {
					summary.Skipped++
					_ = s.Store.RecordDownload(ctx, DownloadInput{
						PinID:       pin.ID,
						SourceURL:   sourceURL,
						ResolvedURL: resolvedURL,
						FilePath:    filePath,
						Status:      StatusSkipped,
						Error:       skipErr.Error(),
						TrackID:     trackID,
						Metadata:    metadata,
					})
					continue
				}
				summary.Failed++
				_ = s.Store.RecordDownload(ctx, DownloadInput{
					PinID:       pin.ID,
					SourceURL:   sourceURL,
					ResolvedURL: resolvedURL,
					FilePath:    filePath,
					Status:      StatusFailed,
					Error:       err.Error(),
					TrackID:     trackID,
					Metadata:    metadata,
				})
				continue
			}
			switch status {
			case StatusDownloaded:
				summary.Downloaded++
			case StatusExisting:
				summary.Existing++
			case StatusSkipped:
				summary.Skipped++
			}
			if ingestInserted {
				summary.Ingested++
			}
			_ = s.Store.RecordDownload(ctx, DownloadInput{
				PinID:       pin.ID,
				SourceURL:   sourceURL,
				ResolvedURL: resolvedURL,
				FilePath:    filePath,
				Status:      status,
				TrackID:     trackID,
				Metadata:    metadata,
			})
		}
	}
	if s.Logger != nil {
		s.Logger.Info("artistgrid scan complete",
			"pin", pin.ID,
			"tracker", pin.TrackerID,
			"tab", summary.Tab,
			"seen", summary.Seen,
			"downloaded", summary.Downloaded,
			"existing", summary.Existing,
			"skipped", summary.Skipped,
			"failed", summary.Failed)
	}
	return nil
}

// expandRecordURLs resolves each tracker URL into the concrete download URLs
// it represents. A lastshare share link fans out into one URL per audio file;
// every other URL passes through unchanged. A lastshare link whose expansion
// fails is kept as-is so the normal download path records it as a failure
// (with the underlying reason logged here).
func (s *Scanner) expandRecordURLs(ctx context.Context, urls []string) []string {
	out := make([]string, 0, len(urls))
	for _, raw := range urls {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		// Resolve lastshare links through the same SSRF-hardened client the
		// download uses — the resolution fetch hits a host derived from an
		// untrusted tracker URL and must get the same IP-level blocking.
		expanded, err := s.client().ExpandSourceURL(ctx, raw, s.downloadClient())
		if err != nil {
			if s.Logger != nil {
				s.Logger.Warn("artistgrid source url expansion failed", "url", raw, "err", err)
			}
			out = append(out, raw)
			continue
		}
		out = append(out, expanded...)
	}
	return out
}

func (s *Scanner) previousStillPresent(ctx context.Context, pinID uuid.UUID, sourceURL string, summary *ScanSummary) bool {
	prev, err := s.Store.DownloadForSource(ctx, pinID, sourceURL)
	if err != nil {
		return false
	}
	switch prev.Status {
	case StatusSkipped:
		if prev.Error == "skipped host" {
			summary.Skipped++
			return true
		}
	case StatusDownloaded, StatusExisting:
		if prev.FilePath != "" && downloadfile.NonEmpty(prev.FilePath) {
			if prev.TrackID == nil {
				trackID, inserted := s.ingestPath(ctx, prev.FilePath, TrackContext{}, false)
				_ = s.Store.RecordDownload(ctx, DownloadInput{
					PinID:       pinID,
					SourceURL:   sourceURL,
					ResolvedURL: prev.ResolvedURL,
					FilePath:    prev.FilePath,
					Status:      StatusExisting,
					TrackID:     trackID,
					Metadata:    prev.Metadata,
				})
				if inserted {
					summary.Ingested++
				}
			}
			summary.Existing++
			return true
		}
	}
	return false
}

func (s *Scanner) downloadOne(
	ctx context.Context,
	pin Pin,
	destBase string,
	rec Record,
	fallbackName string,
	sourceURL string,
	trackCtx TrackContext,
) (status string, resolvedURL string, filePath string, trackID *uuid.UUID, ingestInserted bool, err error) {
	resolvedURL, err = s.client().ResolveDownloadURL(ctx, sourceURL)
	if err != nil {
		return "", "", "", nil, false, err
	}
	if _, err := httpx.ValidateDownloadURL(resolvedURL, s.downloadURLPolicy); err != nil {
		return "", resolvedURL, "", nil, false, downloadfile.SkipError{Reason: err.Error()}
	}
	fileCtx, cancel := context.WithTimeout(ctx, s.fileTimeout())
	defer cancel()
	req, err := http.NewRequestWithContext(fileCtx, http.MethodGet, resolvedURL, nil)
	if err != nil {
		return "", resolvedURL, "", nil, false, err
	}
	for k, v := range artistGridHeaders() {
		req.Header.Set(k, v)
	}
	resp, err := s.downloadClient().Do(req)
	if err != nil {
		return "", resolvedURL, "", nil, false, err
	}
	defer resp.Body.Close()
	resolvedURL = resp.Request.URL.String()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", resolvedURL, "", nil, false, fmt.Errorf("download %s", resp.Status)
	}

	eraName := strings.TrimSpace(rec.EraName)
	if eraName == "" {
		eraName = rec.EraID
	}
	destDir := filepath.Join(destBase, downloadfile.SanitizeName(eraName), downloadfile.SanitizeName(rec.Category))
	name := downloadfile.PickFilename(resp, resp.Request.URL.String(), fallbackName)
	target := filepath.Join(destDir, name)
	if !ingest.IsSupported(target) {
		return "", resolvedURL, target, nil, false, downloadfile.SkipError{Reason: "unsupported file extension"}
	}
	var existing bool
	target, existing, err = downloadfile.Save(resp.Body, target)
	if err != nil {
		return "", resolvedURL, target, nil, false, err
	}
	trackID, ingestInserted = s.ingestPath(ctx, target, trackCtx, !existing)
	status = StatusDownloaded
	if existing {
		status = StatusExisting
	}
	return status, resolvedURL, target, trackID, ingestInserted, nil
}

func (s *Scanner) downloadClient() *http.Client {
	if s != nil && s.downloadHTTP != nil {
		return s.downloadHTTP
	}
	if s == nil || !s.downloadURLPolicy.AllowLoopback {
		return httpx.DefaultDownloadClient()
	}
	return httpx.NewDownloadClient(s.downloadURLPolicy, net.DefaultResolver)
}

func (s *Scanner) ingestPath(ctx context.Context, p string, trackCtx TrackContext, applyTrackerMetadata bool) (*uuid.UUID, bool) {
	if s.Ingest == nil || !ingest.IsSupported(p) {
		return nil, false
	}
	out := s.Ingest.IngestFile(ctx, p)
	if out.Err != nil || out.TrackID == uuid.Nil {
		return nil, false
	}
	if applyTrackerMetadata && out.Inserted && s.Library != nil {
		s.applyTrackerMetadata(ctx, out.TrackID, trackCtx)
	}
	return &out.TrackID, out.Inserted
}

func (s *Scanner) applyTrackerMetadata(ctx context.Context, trackID uuid.UUID, tc TrackContext) {
	if tc.Title == "" {
		return
	}
	artists := []string{}
	if tc.AlbumArtist != "" {
		artists = append(artists, tc.AlbumArtist)
	}
	artists = append(artists, tc.Featured...)
	if len(artists) == 0 && tc.Artist != "" {
		artists = append(artists, tc.Artist)
	}
	patch := library.TrackPatch{
		Title: &tc.Title,
	}
	if tc.Year > 0 {
		patch.Year = &tc.Year
	}
	if tc.Genre != "" {
		patch.Genre = &tc.Genre
	}
	if tc.Composer != "" {
		patch.Composer = &tc.Composer
	}
	if tc.Comment != "" {
		patch.Comments = &tc.Comment
	}
	if len(artists) > 0 {
		patch.Artists = &artists
	}
	if tc.Album != "" {
		patch.AlbumTitle = &tc.Album
		if tc.AlbumArtist != "" {
			patch.AlbumArtist = &tc.AlbumArtist
		}
	}
	if err := s.Library.UpdateTrack(ctx, trackID, patch); err != nil && s.Logger != nil {
		s.Logger.Warn("artistgrid metadata patch failed", "track", trackID, "err", err)
	}
}

func pinDestination(pin Pin) (string, error) {
	root, err := filepath.Abs(pin.RootPath)
	if err != nil {
		return "", err
	}
	sub := strings.TrimSpace(pin.DestinationSubdir)
	if sub == "" || filepath.Clean(sub) == "." {
		return root, nil
	}
	if filepath.IsAbs(sub) {
		return "", fmt.Errorf("destination_subdir must be relative")
	}
	dest, err := pathsafe.CleanSubdir(root, sub)
	if err != nil {
		return "", fmt.Errorf("destination_subdir escapes root")
	}
	return dest, nil
}

func recordMetadata(data TrackerData, pin Pin, tab string, rec Record, tc TrackContext) json.RawMessage {
	b, err := json.Marshal(map[string]any{
		"tracker_id":     pin.TrackerID,
		"tracker":        data.Name,
		"tab":            tab,
		"era_id":         rec.EraID,
		"era":            rec.EraName,
		"category":       rec.Category,
		"item":           rec.Item,
		"primary_artist": tc.AlbumArtist,
	})
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return b
}
