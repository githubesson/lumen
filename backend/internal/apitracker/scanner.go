package apitracker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/dbtext"
	"github.com/githubesson/lumen/internal/downloadfile"
	"github.com/githubesson/lumen/internal/httpx"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/musicroots"
	"github.com/githubesson/lumen/internal/pinscan"
	"github.com/githubesson/lumen/internal/sourceurl"
)

// Fallback per-file download deadline when *_FILE_TIMEOUT is unset or <= 0.
const defaultFileTimeout = 30 * time.Minute

type Scanner struct {
	Store  *Store
	Client *Client
	// BaseURLOverride, when non-blank, takes precedence over every pin's
	// stored api_base_url. Set from API_TRACKER_BASE_URL so the tracker-API
	// instance can be swapped without rewriting pins in the database.
	BaseURLOverride string
	Ingest          *ingest.Service
	Library         *library.Store
	Roots           *musicroots.Store
	Logger          *slog.Logger
	PollInterval    time.Duration
	FileTimeout     time.Duration

	downloadHTTP      *http.Client
	downloadURLPolicy httpx.DownloadPolicy

	scans pinscan.Group
}

type ScanSummary struct {
	PinID      uuid.UUID `json:"pin_id"`
	TrackerID  int64     `json:"tracker_id"`
	Tracker    string    `json:"tracker"`
	Seen       int       `json:"seen"`
	NoURL      int       `json:"no_url"`
	Downloaded int       `json:"downloaded"`
	Existing   int       `json:"existing"`
	Skipped    int       `json:"skipped"`
	Failed     int       `json:"failed"`
	Ingested   int       `json:"ingested"`
}

type TrackContext struct {
	Title       string
	Artist      string
	AlbumArtist string
	Album       string
	Year        int
	Genre       string
	Composer    string
	Comment     string
	Featured    []string
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
	s.scans.Go(id, "api tracker manual scan", func() {
		_, err := s.ScanPin(ctx, pin)
		if err != nil && s.Logger != nil {
			s.Logger.Warn("api tracker manual scan failed", "pin", id, "err", err)
		}
	})
	return true, nil
}

func (s *Scanner) scanDue(ctx context.Context) {
	pins, err := s.Store.DuePins(ctx, pinscan.DefaultScanBatch)
	if err != nil {
		if s.Logger != nil && !errors.Is(err, context.Canceled) {
			s.Logger.Warn("api tracker due pins fetch failed", "err", err)
		}
		return
	}
	for _, pin := range pins {
		if !s.scans.TryBegin(pin.ID) {
			continue
		}
		s.scans.Go(pin.ID, "api tracker scheduled scan", func() {
			_, err := s.ScanPin(ctx, pin)
			if err != nil && s.Logger != nil {
				s.Logger.Warn("api tracker scheduled scan failed", "pin", pin.ID, "tracker", pin.TrackerID, "err", err)
			}
		})
	}
}

// Wait blocks until all scheduled and manually-triggered scans have stopped.
// Call it after Run has returned so no new jobs can be added.
func (s *Scanner) Wait() { s.scans.Wait() }

func (s *Scanner) ScanPin(ctx context.Context, pin Pin) (ScanSummary, error) {
	summary := ScanSummary{PinID: pin.ID, TrackerID: pin.TrackerID}
	if err := s.Store.MarkScanStarted(ctx, pin.ID); err != nil {
		return summary, err
	}
	scanErr := s.scanPin(ctx, pin, &summary)
	if err := s.Store.MarkScanFinished(ctx, pin.ID, scanErr); err != nil && scanErr == nil {
		scanErr = err
	}
	return summary, scanErr
}

// scanRun is the state one pin scan shares across its entries.
type scanRun struct {
	pin Pin
	// history is the pin's downloads by source URL, loaded once per scan and
	// kept current by record.
	history map[string]Download
	// settled holds the source URLs this scan has handled. A link listed
	// under several entries keeps the first entry's tags: comparing the next
	// entry's against them would re-apply tags back and forth every scan.
	settled map[string]bool
	covers  eraCovers
	summary *ScanSummary
}

func (s *Scanner) scanPin(ctx context.Context, pin Pin, summary *ScanSummary) error {
	destBase, err := pinscan.Destination(ctx, s.Roots, pin.RootID, pin.RootPath, pin.DestinationSubdir)
	if err != nil {
		return err
	}
	client := s.clientFor(pin)
	tracker, err := client.FetchTracker(ctx, pin.TrackerID)
	if err != nil {
		return err
	}
	trackerName := strings.TrimSpace(tracker.TrackerName)
	if trackerName == "" {
		trackerName = pin.TrackerName
	}
	summary.Tracker = trackerName
	if trackerName != pin.TrackerName || tracker.URL != pin.TrackerURL {
		if err := s.Store.MarkTrackerMetadata(ctx, pin.ID, trackerName, tracker.URL); err != nil && s.Logger != nil {
			s.Logger.Warn("api tracker metadata update failed", "pin", pin.ID, "err", err)
		}
	}
	entries, err := client.FetchEntries(ctx, pin.TrackerID)
	if err != nil {
		return err
	}
	history, err := s.Store.downloadsBySource(ctx, pin.ID)
	if err != nil {
		return fmt.Errorf("load api tracker download history: %w", err)
	}
	run := &scanRun{
		pin:     pin,
		history: history,
		settled: map[string]bool{},
		covers: eraCovers{
			client: client,
			images: s.fetchEraImageIDs(ctx, client, pin.TrackerID),
			keys:   map[int64]string{},
		},
		summary: summary,
	}
	for _, entry := range entries {
		if !pinMatchesEntryTab(pin, entry) {
			continue
		}
		if len(entry.Links) == 0 {
			summary.NoURL++
			continue
		}
		trackCtx := BuildContext(tracker, pin, entry)
		sourceURLs := s.expandRecordURLs(ctx, client, entry.Links)
		for i, sourceURL := range sourceURLs {
			sourceURL = strings.TrimSpace(sourceURL)
			if sourceURL == "" {
				summary.NoURL++
				continue
			}
			summary.Seen++
			fallback := downloadfile.SanitizeName(trackCtx.Title)
			if fallback == "" || fallback == "unnamed" {
				fallback = fmt.Sprintf("tracker-%d-entry-%d", pin.TrackerID, entry.ID)
			}
			if len(sourceURLs) > 1 {
				fallback = fmt.Sprintf("%s_%d", fallback, i+1)
			}
			metadata := entryMetadata(tracker, pin, entry, trackCtx)
			if sourceurl.ShouldSkipURL(sourceURL) {
				summary.Skipped++
				s.record(ctx, run, DownloadInput{
					PinID:     pin.ID,
					EntryID:   entry.ID,
					SourceURL: sourceURL,
					Status:    StatusSkipped,
					Error:     downloadfile.SkippedHost,
					Metadata:  metadata,
				})
				continue
			}
			if s.previousStillPresent(ctx, run, sourceURL, metadata, trackCtx) {
				continue
			}
			status, resolvedURL, filePath, trackID, ingestInserted, err := s.downloadOne(
				ctx, client, pin, destBase, entry, fallback, sourceURL, trackCtx,
			)
			if err != nil {
				var skipErr downloadfile.SkipError
				if errors.As(err, &skipErr) {
					summary.Skipped++
					s.record(ctx, run, DownloadInput{
						PinID:       pin.ID,
						EntryID:     entry.ID,
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
				s.record(ctx, run, DownloadInput{
					PinID:       pin.ID,
					EntryID:     entry.ID,
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
			if applied, _ := s.applyTrackerMetadataForFile(ctx, trackID, filePath, trackCtx); applied {
				s.applyEraCover(ctx, &run.covers, trackID, trackCtx.Album)
			}
			s.record(ctx, run, DownloadInput{
				PinID:       pin.ID,
				EntryID:     entry.ID,
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
		s.Logger.Info("api tracker scan complete",
			"pin", pin.ID,
			"tracker", pin.TrackerID,
			"tab", pin.Tab,
			"seen", summary.Seen,
			"downloaded", summary.Downloaded,
			"existing", summary.Existing,
			"skipped", summary.Skipped,
			"failed", summary.Failed)
	}
	return nil
}

// record stores a download outcome and mirrors it into the scan's history, so
// a link listed twice in one scan sees how the first went.
func (s *Scanner) record(ctx context.Context, run *scanRun, in DownloadInput) {
	key := dbtext.Clean(in.SourceURL)
	run.settled[key] = true
	if err := s.Store.RecordDownload(ctx, in); err != nil {
		return
	}
	d := run.history[key]
	d.PinID, d.SourceURL, d.ResolvedURL = in.PinID, key, in.ResolvedURL
	d.Status, d.Error, d.Metadata = in.Status, in.Error, in.Metadata
	if len(d.Metadata) == 0 {
		d.Metadata = json.RawMessage(`{}`)
	}
	if in.EntryID != 0 {
		d.EntryID = in.EntryID
	}
	if in.FilePath != "" {
		d.FilePath = in.FilePath
	}
	if in.TrackID != nil {
		d.TrackID = in.TrackID
	}
	d.albumNeedsCover = false
	run.history[key] = d
}

func pinMatchesEntryTab(pin Pin, entry Entry) bool {
	tab := strings.TrimSpace(pin.Tab)
	if tab == "" {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(entry.SheetName), tab)
}

func (s *Scanner) fetchEraImageIDs(ctx context.Context, client *Client, trackerID int64) map[string]int64 {
	eras, err := client.FetchEras(ctx, trackerID)
	if err != nil {
		if s.Logger != nil {
			s.Logger.Warn("api tracker eras fetch failed", "tracker", trackerID, "err", err)
		}
		return nil
	}
	out := make(map[string]int64, len(eras)*2)
	for _, era := range eras {
		if era.ImageID <= 0 {
			continue
		}
		for _, key := range []string{era.EraKey, era.Era} {
			key = normalizeEraKey(key)
			if key != "" {
				out[key] = era.ImageID
			}
		}
	}
	return out
}

// eraCovers resolves era images to stored cover keys for one scan. An image is
// fetched and stored at most once per scan, and only for an album that has no
// cover yet: SetTrackAlbumCover never replaces one, so once an era's albums
// have covers, scans fetch nothing.
type eraCovers struct {
	client *Client
	images map[string]int64 // normalized era name -> image id
	keys   map[int64]string // image id -> cover key, "" after a failure
}

func (c *eraCovers) imageID(era string) int64 {
	return c.images[normalizeEraKey(era)]
}

func (s *Scanner) eraCoverKey(ctx context.Context, c *eraCovers, era string) string {
	if s == nil || s.Ingest == nil {
		return ""
	}
	imageID := c.imageID(era)
	if imageID <= 0 {
		return ""
	}
	if key, ok := c.keys[imageID]; ok {
		return key
	}
	data, contentType, err := c.client.FetchEraImage(ctx, imageID)
	if err != nil {
		if s.Logger != nil {
			s.Logger.Warn("api tracker era image fetch failed", "image_id", imageID, "era", era, "err", err)
		}
		c.keys[imageID] = ""
		return ""
	}
	key, err := s.Ingest.StoreCoverImage(ctx, data, contentType)
	if err != nil {
		if s.Logger != nil {
			s.Logger.Warn("api tracker era image store failed", "image_id", imageID, "era", era, "err", err)
		}
		c.keys[imageID] = ""
		return ""
	}
	c.keys[imageID] = key
	return key
}

func normalizeEraKey(raw string) string {
	return strings.Join(strings.Fields(strings.ToLower(strings.TrimSpace(raw))), " ")
}

// fileTimeout reads the configured per-file deadline, falling back to the
// default. ScanPin runs concurrently (scanDue fans out one goroutine per due
// pin while StartPinScan adds more from the admin handler), so defaults must
// never be written back into the shared Scanner — that was an unsynchronized
// write to a field other goroutines read.
func (s *Scanner) fileTimeout() time.Duration {
	if s.FileTimeout > 0 {
		return s.FileTimeout
	}
	return defaultFileTimeout
}

func (s *Scanner) baseURLFor(pin Pin) string {
	if override := strings.TrimSpace(s.BaseURLOverride); override != "" {
		return override
	}
	return pin.APIBaseURL
}

func (s *Scanner) clientFor(pin Pin) *Client {
	base := s.baseURLFor(pin)
	if s.Client == nil {
		return NewClient(base)
	}
	copy := *s.Client
	copy.BaseURL = NormalizeBaseURL(base)
	if copy.HTTP == nil {
		copy.HTTP = NewClient(base).HTTP
	}
	return &copy
}

func (s *Scanner) expandRecordURLs(ctx context.Context, client *Client, urls []string) []string {
	out := make([]string, 0, len(urls))
	for _, raw := range urls {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		expanded, err := client.ExpandSourceURL(ctx, raw, s.downloadClient())
		if err != nil {
			if s.Logger != nil {
				s.Logger.Warn("api tracker source url expansion failed", "url", raw, "err", err)
			}
			out = append(out, raw)
			continue
		}
		out = append(out, expanded...)
	}
	return out
}

// previousStillPresent settles a link the pin has handled before: a final
// skip (downloadfile.SkipFinal) stands, and a download whose file is still
// there counts as existing rather than being fetched again. It reports
// whether the link is settled.
func (s *Scanner) previousStillPresent(ctx context.Context, run *scanRun, sourceURL string, metadata json.RawMessage, trackCtx TrackContext) bool {
	prev, ok := run.history[dbtext.Clean(sourceURL)]
	if !ok {
		return false
	}
	switch prev.Status {
	case StatusSkipped:
		if downloadfile.SkipFinal(prev.Error, ingest.IsSupported) {
			run.summary.Skipped++
			return true
		}
	case StatusDownloaded, StatusExisting:
		if !pinscan.DownloadPresent(ctx, s.Store.db, prev.FilePath, prev.TrackID) {
			return false
		}
		if prev.TrackID == nil {
			trackID, inserted := s.ingestPath(ctx, prev.FilePath)
			if applied, _ := s.applyTrackerMetadataForFile(ctx, trackID, prev.FilePath, trackCtx); applied {
				s.applyEraCover(ctx, &run.covers, trackID, trackCtx.Album)
			}
			s.record(ctx, run, DownloadInput{
				PinID:       run.pin.ID,
				EntryID:     prev.EntryID,
				SourceURL:   sourceURL,
				ResolvedURL: prev.ResolvedURL,
				FilePath:    prev.FilePath,
				Status:      StatusExisting,
				TrackID:     trackID,
				Metadata:    metadata,
			})
			if inserted {
				run.summary.Ingested++
			}
		} else {
			s.refreshTrackerMetadata(ctx, run, prev, metadata, trackCtx)
		}
		run.summary.Existing++
		return true
	}
	return false
}

// refreshTrackerMetadata re-applies the tracker's tags to a track it
// downloaded earlier only when they changed since, so edits made in Lumen
// survive later scans. A track whose album still has no cover gets the era
// image either way. Only the first entry listing a link in a scan counts
// (scanRun.settled).
func (s *Scanner) refreshTrackerMetadata(ctx context.Context, run *scanRun, prev Download, metadata json.RawMessage, trackCtx TrackContext) {
	if run.settled[prev.SourceURL] {
		return
	}
	run.settled[prev.SourceURL] = true
	tagsChanged, differs := compareEntryMetadata(prev.Metadata, metadata)
	switch {
	case tagsChanged:
		applied, err := s.applyTrackerMetadataForFile(ctx, prev.TrackID, prev.FilePath, trackCtx)
		if err != nil {
			// Keep the old record, so the next scan sees the change and
			// tries again.
			return
		}
		if applied {
			s.applyEraCover(ctx, &run.covers, prev.TrackID, trackCtx.Album)
		}
	case prev.albumNeedsCover && s.Ingest != nil && run.covers.imageID(trackCtx.Album) > 0:
		if owns, _ := s.ownsFile(ctx, prev.TrackID, prev.FilePath); owns {
			s.applyEraCover(ctx, &run.covers, prev.TrackID, trackCtx.Album)
		}
	}
	if !differs {
		return
	}
	if err := s.Store.SetDownloadMetadata(ctx, run.pin.ID, prev.SourceURL, metadata); err != nil {
		if s.Logger != nil {
			s.Logger.Warn("api tracker download metadata update failed", "pin", run.pin.ID, "url", prev.SourceURL, "err", err)
		}
		return
	}
	prev.Metadata = metadata
	run.history[prev.SourceURL] = prev
}

// appliedMetadataKeys are the entryMetadata keys behind the tags
// applyTrackerMetadata writes. The rest, like row_number, change when rows
// are added above an entry without saying anything new about it.
var appliedMetadataKeys = []string{"title", "era", "primary_artist", "featured", "producer", "year", "genre", "comment"}

// compareEntryMetadata compares the metadata recorded with an earlier download
// against this scan's. tagsChanged means an applied tag differs; a key the
// record lacks, written before the key existed, doesn't count. differs means
// the record is out of date at all.
func compareEntryMetadata(prev, next json.RawMessage) (tagsChanged, differs bool) {
	var old, cur map[string]any
	if json.Unmarshal(prev, &old) != nil || old == nil {
		return true, true
	}
	if json.Unmarshal(next, &cur) != nil {
		return false, false
	}
	for _, key := range appliedMetadataKeys {
		if v, ok := old[key]; ok && !reflect.DeepEqual(v, cur[key]) {
			return true, true
		}
	}
	return false, !reflect.DeepEqual(old, cur)
}

func (s *Scanner) downloadOne(
	ctx context.Context,
	client *Client,
	pin Pin,
	destBase string,
	entry Entry,
	fallbackName string,
	sourceURL string,
	trackCtx TrackContext,
) (status string, resolvedURL string, filePath string, trackID *uuid.UUID, ingestInserted bool, err error) {
	resolvedURL, err = client.ResolveDownloadURL(ctx, sourceURL)
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
	req.Header.Set("User-Agent", "Lumen API tracker downloader")
	resp, err := s.downloadClient().Do(req)
	if err != nil {
		return "", resolvedURL, "", nil, false, err
	}
	defer resp.Body.Close()
	resolvedURL = resp.Request.URL.String()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", resolvedURL, "", nil, false, fmt.Errorf("download %s", resp.Status)
	}

	eraName := strings.TrimSpace(trackCtx.Album)
	if eraName == "" {
		eraName = "Unsorted"
	}
	category := strings.TrimSpace(trackCtx.Genre)
	if category == "" {
		category = "Tracks"
	}
	destDir := filepath.Join(destBase, downloadfile.SanitizeName(eraName), downloadfile.SanitizeName(category))
	name := downloadfile.PickFilename(resp, resp.Request.URL.String(), fallbackName)
	target := filepath.Join(destDir, name)
	if !ingest.IsSupported(target) {
		return "", resolvedURL, target, nil, false, downloadfile.UnsupportedExtension(target)
	}
	var existing bool
	target, existing, err = downloadfile.Save(resp.Body, target)
	if err != nil {
		return "", resolvedURL, target, nil, false, err
	}
	trackID, ingestInserted = s.ingestPath(ctx, target)
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

func (s *Scanner) ingestPath(ctx context.Context, p string) (*uuid.UUID, bool) {
	if s.Ingest == nil || !ingest.IsSupported(p) {
		return nil, false
	}
	out := s.Ingest.IngestFile(ctx, p)
	if out.Err != nil || out.TrackID == uuid.Nil {
		return nil, false
	}
	return &out.TrackID, out.Inserted
}

func (s *Scanner) applyTrackerMetadata(ctx context.Context, trackID uuid.UUID, tc TrackContext) error {
	if tc.Title == "" {
		return nil
	}
	artists := []string{}
	if tc.AlbumArtist != "" {
		artists = append(artists, tc.AlbumArtist)
	}
	artists = append(artists, tc.Featured...)
	if len(artists) == 0 && tc.Artist != "" {
		artists = append(artists, tc.Artist)
	}
	patch := library.TrackPatch{Title: &tc.Title}
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
	return s.Library.UpdateTrack(ctx, trackID, patch)
}

// applyTrackerMetadataForFile applies the tracker's tags when filePath is
// still the track's own file, not one ingest folded into another track. It
// reports whether it applied them; err, already logged, means it couldn't
// tell or the update failed, rather than that the file isn't the track's.
func (s *Scanner) applyTrackerMetadataForFile(ctx context.Context, trackID *uuid.UUID, filePath string, tc TrackContext) (bool, error) {
	owns, err := s.ownsFile(ctx, trackID, filePath)
	if !owns || err != nil {
		return false, err
	}
	if err := s.applyTrackerMetadata(ctx, *trackID, tc); err != nil {
		if s.Logger != nil {
			s.Logger.Warn("api tracker metadata patch failed", "track", *trackID, "err", err)
		}
		return false, err
	}
	return true, nil
}

// ownsFile reports whether filePath is still trackID's own file. A failed
// check is logged as well as returned.
func (s *Scanner) ownsFile(ctx context.Context, trackID *uuid.UUID, filePath string) (bool, error) {
	if s == nil || s.Library == nil || trackID == nil || *trackID == uuid.Nil || strings.TrimSpace(filePath) == "" {
		return false, nil
	}
	ok, err := s.Library.TrackHasFilePath(ctx, *trackID, filePath)
	if err != nil {
		if s.Logger != nil {
			s.Logger.Warn("api tracker track path check failed", "track", *trackID, "path", filePath, "err", err)
		}
		return false, err
	}
	return ok, nil
}

// applyEraCover gives the track's album its era image when it has no cover.
func (s *Scanner) applyEraCover(ctx context.Context, covers *eraCovers, trackID *uuid.UUID, era string) {
	if s == nil || s.Library == nil || s.Ingest == nil || trackID == nil || *trackID == uuid.Nil || covers.imageID(era) <= 0 {
		return
	}
	needs, err := s.Library.TrackAlbumNeedsCover(ctx, *trackID)
	if err != nil {
		if s.Logger != nil {
			s.Logger.Warn("api tracker album cover check failed", "track", *trackID, "err", err)
		}
		return
	}
	if !needs {
		return
	}
	coverKey := s.eraCoverKey(ctx, covers, era)
	if coverKey == "" {
		return
	}
	if err := s.Library.SetTrackAlbumCover(ctx, *trackID, coverKey); err != nil && s.Logger != nil {
		s.Logger.Warn("api tracker album cover apply failed", "track", *trackID, "cover_key", coverKey, "err", err)
	}
}

func BuildContext(tracker Tracker, pin Pin, entry Entry) TrackContext {
	primary := strings.TrimSpace(pin.PrimaryArtist)
	if primary == "" {
		primary = GuessPrimaryArtist(firstNonEmpty(tracker.TrackerName, pin.TrackerName))
	}
	title := firstNonEmpty(anyString(entry.Name), fieldString(entry.Fields, "name"), fieldString(entry.Raw, "Name"))
	if title == "" {
		title = "Unknown"
	}
	cleanTitle, fallbackProducer, altTitle, fallbackFeatured := parseTitleCredits(title, apiTrackerExtraText(entry))
	if cleanTitle != "" {
		title = cleanTitle
	}
	producer := firstNonEmpty(apiTrackerProducer(entry), fallbackProducer)
	featured := dedupeStrings(append(apiTrackerFeatured(entry), fallbackFeatured...))
	era := firstNonEmpty(
		anyString(entry.Era),
		anyString(entry.RecEra),
		anyString(entry.RelEra),
		fieldString(entry.Fields, "era"),
		entry.SheetName,
	)
	genre := firstNonEmpty(anyString(entry.Type), anyString(entry.Portion), anyString(entry.Quality), "Tracks")
	year := firstYear(
		anyString(entry.RecEra),
		anyString(entry.RelEra),
		anyString(entry.FileDate),
		anyString(entry.LeakDate),
		era,
	)
	artist := primary
	if len(featured) > 0 {
		artist = primary + " feat. " + strings.Join(featured, ", ")
	}
	commentParts := []string{}
	if altTitle != "" {
		commentParts = append(commentParts, "Alt title: "+altTitle)
	}
	return TrackContext{
		Title:       title,
		Artist:      artist,
		AlbumArtist: primary,
		Album:       era,
		Year:        year,
		Genre:       genre,
		Composer:    producer,
		Comment:     strings.Join(commentParts, "\n\n"),
		Featured:    featured,
	}
}

func entryMetadata(tracker Tracker, pin Pin, entry Entry, tc TrackContext) json.RawMessage {
	b, err := json.Marshal(map[string]any{
		"api_base_url":   pin.APIBaseURL,
		"tracker_id":     pin.TrackerID,
		"tracker":        firstNonEmpty(tracker.TrackerName, pin.TrackerName),
		"tracker_url":    firstNonEmpty(tracker.URL, pin.TrackerURL),
		"tab":            pin.Tab,
		"entry_id":       entry.ID,
		"sheet_id":       entry.SheetID,
		"sheet":          entry.SheetName,
		"row_number":     entry.RowNumber,
		"era":            tc.Album,
		"title":          tc.Title,
		"type":           anyString(entry.Type),
		"quality":        anyString(entry.Quality),
		"primary_artist": tc.AlbumArtist,
		"featured":       tc.Featured,
		"producer":       tc.Composer,
		"year":           tc.Year,
		"genre":          tc.Genre,
		"comment":        tc.Comment,
	})
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return b
}
