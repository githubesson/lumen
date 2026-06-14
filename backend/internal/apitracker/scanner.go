package apitracker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/httpx"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/pathsafe"
	"github.com/githubesson/lumen/internal/pinscan"
)

const skipHost = "music.froste.lol"

var invalidNameChars = strings.NewReplacer(
	"<", "_", ">", "_", ":", "_", `"`, "_", "/", "_", `\`, "_",
	"|", "_", "?", "_", "*", "_", "\n", "_", "\r", "_", "\t", "_",
)

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

	mu       sync.Mutex
	inflight map[uuid.UUID]struct{}
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
	interval := s.PollInterval
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	timer := time.NewTimer(pinscan.InitialScanDelay)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			s.scanDue(ctx)
			timer.Reset(interval)
		}
	}
}

func (s *Scanner) StartPinScan(ctx context.Context, id uuid.UUID) (bool, error) {
	if !s.tryBegin(id) {
		return false, nil
	}
	pin, err := s.Store.GetPin(ctx, id)
	if err != nil {
		s.end(id)
		return false, err
	}
	go func() {
		defer s.end(id)
		_, err := s.ScanPin(ctx, pin)
		if err != nil && s.Logger != nil {
			s.Logger.Warn("api tracker manual scan failed", "pin", id, "err", err)
		}
	}()
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
		if !s.tryBegin(pin.ID) {
			continue
		}
		go func(pin Pin) {
			defer s.end(pin.ID)
			_, err := s.ScanPin(ctx, pin)
			if err != nil && s.Logger != nil {
				s.Logger.Warn("api tracker scheduled scan failed", "pin", pin.ID, "tracker", pin.TrackerID, "err", err)
			}
		}(pin)
	}
}

func (s *Scanner) ScanPin(ctx context.Context, pin Pin) (ScanSummary, error) {
	summary := ScanSummary{PinID: pin.ID, TrackerID: pin.TrackerID}
	if s.Client == nil {
		s.Client = NewClient(pin.APIBaseURL)
	}
	if s.FileTimeout <= 0 {
		s.FileTimeout = 30 * time.Minute
	}
	if err := s.Store.MarkScanStarted(ctx, pin.ID); err != nil {
		return summary, err
	}
	scanErr := s.scanPin(ctx, pin, &summary)
	if err := s.Store.MarkScanFinished(ctx, pin.ID, scanErr); err != nil && scanErr == nil {
		scanErr = err
	}
	return summary, scanErr
}

func (s *Scanner) scanPin(ctx context.Context, pin Pin, summary *ScanSummary) error {
	destBase, err := pinDestination(pin)
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
	eraImages := s.fetchEraImageIDs(ctx, client, pin.TrackerID)
	eraCoverKeys := map[int64]string{}
	entries, err := client.FetchEntries(ctx, pin.TrackerID)
	if err != nil {
		return err
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
		coverKey := s.eraCoverKey(ctx, client, eraImages, eraCoverKeys, trackCtx.Album)
		sourceURLs := s.expandRecordURLs(ctx, client, entry.Links)
		for i, sourceURL := range sourceURLs {
			sourceURL = strings.TrimSpace(sourceURL)
			if sourceURL == "" {
				summary.NoURL++
				continue
			}
			summary.Seen++
			fallback := SanitizeName(trackCtx.Title)
			if fallback == "" || fallback == "unnamed" {
				fallback = fmt.Sprintf("tracker-%d-entry-%d", pin.TrackerID, entry.ID)
			}
			if len(sourceURLs) > 1 {
				fallback = fmt.Sprintf("%s_%d", fallback, i+1)
			}
			metadata := entryMetadata(tracker, pin, entry, trackCtx)
			if ShouldSkipURL(sourceURL) {
				summary.Skipped++
				_ = s.Store.RecordDownload(ctx, DownloadInput{
					PinID:     pin.ID,
					EntryID:   entry.ID,
					SourceURL: sourceURL,
					Status:    StatusSkipped,
					Error:     "skipped host",
					Metadata:  metadata,
				})
				continue
			}
			if s.previousStillPresent(ctx, pin.ID, sourceURL, trackCtx, coverKey, summary) {
				continue
			}
			status, resolvedURL, filePath, trackID, ingestInserted, err := s.downloadOne(
				ctx, client, pin, destBase, entry, fallback, sourceURL, trackCtx,
			)
			if err != nil {
				var skipErr skipDownloadError
				if errors.As(err, &skipErr) {
					summary.Skipped++
					_ = s.Store.RecordDownload(ctx, DownloadInput{
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
				_ = s.Store.RecordDownload(ctx, DownloadInput{
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
			if s.applyTrackerMetadataForFile(ctx, trackID, filePath, trackCtx) {
				s.applyTrackAlbumCover(ctx, trackID, coverKey)
			}
			_ = s.Store.RecordDownload(ctx, DownloadInput{
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

func (s *Scanner) eraCoverKey(ctx context.Context, client *Client, eraImages map[string]int64, cache map[int64]string, era string) string {
	if s == nil || s.Ingest == nil || len(eraImages) == 0 {
		return ""
	}
	imageID := eraImages[normalizeEraKey(era)]
	if imageID <= 0 {
		return ""
	}
	if key, ok := cache[imageID]; ok {
		return key
	}
	data, contentType, err := client.FetchEraImage(ctx, imageID)
	if err != nil {
		if s.Logger != nil {
			s.Logger.Warn("api tracker era image fetch failed", "image_id", imageID, "era", era, "err", err)
		}
		cache[imageID] = ""
		return ""
	}
	key, err := s.Ingest.StoreCoverImage(ctx, data, contentType)
	if err != nil {
		if s.Logger != nil {
			s.Logger.Warn("api tracker era image store failed", "image_id", imageID, "era", era, "err", err)
		}
		cache[imageID] = ""
		return ""
	}
	cache[imageID] = key
	return key
}

func normalizeEraKey(raw string) string {
	return strings.Join(strings.Fields(strings.ToLower(strings.TrimSpace(raw))), " ")
}

func (s *Scanner) clientFor(pin Pin) *Client {
	if s.Client == nil {
		return NewClient(pin.APIBaseURL)
	}
	copy := *s.Client
	copy.BaseURL = NormalizeBaseURL(pin.APIBaseURL)
	if copy.HTTP == nil {
		copy.HTTP = NewClient(pin.APIBaseURL).HTTP
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

func (s *Scanner) previousStillPresent(ctx context.Context, pinID uuid.UUID, sourceURL string, trackCtx TrackContext, coverKey string, summary *ScanSummary) bool {
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
		if prev.FilePath != "" && fileNonEmpty(prev.FilePath) {
			if prev.TrackID == nil {
				trackID, inserted := s.ingestPath(ctx, prev.FilePath, trackCtx, false)
				if s.applyTrackerMetadataForFile(ctx, trackID, prev.FilePath, trackCtx) {
					s.applyTrackAlbumCover(ctx, trackID, coverKey)
				}
				_ = s.Store.RecordDownload(ctx, DownloadInput{
					PinID:       pinID,
					EntryID:     prev.EntryID,
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
			} else {
				if s.applyTrackerMetadataForFile(ctx, prev.TrackID, prev.FilePath, trackCtx) {
					s.applyTrackAlbumCover(ctx, prev.TrackID, coverKey)
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
		return "", resolvedURL, "", nil, false, skipDownloadError{reason: err.Error()}
	}
	fileCtx, cancel := context.WithTimeout(ctx, s.FileTimeout)
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
	destDir := filepath.Join(destBase, SanitizeName(eraName), SanitizeName(category))
	name := PickFilename(resp, resp.Request.URL.String(), fallbackName)
	target := filepath.Join(destDir, name)
	if !ingest.IsSupported(target) {
		return "", resolvedURL, target, nil, false, skipDownloadError{reason: "unsupported file extension"}
	}
	if fileNonEmpty(target) {
		trackID, ingestInserted = s.ingestPath(ctx, target, trackCtx, false)
		return StatusExisting, resolvedURL, target, trackID, ingestInserted, nil
	}
	if pathExists(target) {
		target = nextAvailablePath(target)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		if isReadOnlyDestinationError(err) {
			return "", resolvedURL, target, nil, false, skipDownloadError{reason: "destination is read-only"}
		}
		return "", resolvedURL, target, nil, false, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), "."+filepath.Base(target)+".*.part")
	if err != nil {
		if isReadOnlyDestinationError(err) {
			return "", resolvedURL, target, nil, false, skipDownloadError{reason: "destination is read-only"}
		}
		return "", resolvedURL, target, nil, false, err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	if _, err := io.Copy(tmp, resp.Body); err != nil {
		tmp.Close()
		return "", resolvedURL, target, nil, false, err
	}
	if err := tmp.Close(); err != nil {
		return "", resolvedURL, target, nil, false, err
	}
	if pathExists(target) {
		if fileNonEmpty(target) {
			trackID, ingestInserted = s.ingestPath(ctx, target, trackCtx, false)
			return StatusExisting, resolvedURL, target, trackID, ingestInserted, nil
		}
		target = nextAvailablePath(target)
	}
	target, err = installNoOverwrite(tmpPath, target)
	if err != nil {
		return "", resolvedURL, target, nil, false, err
	}
	trackID, ingestInserted = s.ingestPath(ctx, target, trackCtx, false)
	return StatusDownloaded, resolvedURL, target, trackID, ingestInserted, nil
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
	if err := s.Library.UpdateTrack(ctx, trackID, patch); err != nil && s.Logger != nil {
		s.Logger.Warn("api tracker metadata patch failed", "track", trackID, "err", err)
	}
}

func (s *Scanner) applyTrackerMetadataForFile(ctx context.Context, trackID *uuid.UUID, filePath string, tc TrackContext) bool {
	if s == nil || s.Library == nil || trackID == nil || *trackID == uuid.Nil || strings.TrimSpace(filePath) == "" {
		return false
	}
	ok, err := s.Library.TrackHasFilePath(ctx, *trackID, filePath)
	if err != nil {
		if s.Logger != nil {
			s.Logger.Warn("api tracker track path check failed", "track", *trackID, "path", filePath, "err", err)
		}
		return false
	}
	if !ok {
		return false
	}
	s.applyTrackerMetadata(ctx, *trackID, tc)
	return true
}

func (s *Scanner) applyTrackAlbumCover(ctx context.Context, trackID *uuid.UUID, coverKey string) {
	if s == nil || s.Library == nil || trackID == nil || *trackID == uuid.Nil || coverKey == "" {
		return
	}
	if err := s.Library.SetTrackAlbumCover(ctx, *trackID, coverKey); err != nil && s.Logger != nil {
		s.Logger.Warn("api tracker album cover apply failed", "track", *trackID, "cover_key", coverKey, "err", err)
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
	})
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return b
}

func nextAvailablePath(target string) string {
	if _, err := os.Stat(target); errors.Is(err, os.ErrNotExist) {
		return target
	}
	ext := filepath.Ext(target)
	base := strings.TrimSuffix(target, ext)
	for i := 1; i < 10000; i++ {
		cand := fmt.Sprintf("%s-%d%s", base, i, ext)
		if _, err := os.Stat(cand); errors.Is(err, os.ErrNotExist) {
			return cand
		}
	}
	return fmt.Sprintf("%s-%d%s", base, time.Now().UnixNano(), ext)
}

func fileNonEmpty(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir() && info.Size() > 0
}

func pathExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

type skipDownloadError struct {
	reason string
}

func (e skipDownloadError) Error() string {
	return e.reason
}

func isReadOnlyDestinationError(err error) bool {
	if err == nil {
		return false
	}
	if os.IsPermission(err) {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "read-only file system")
}

func installNoOverwrite(tmpPath, target string) (string, error) {
	for i := 0; i < 10000; i++ {
		if err := os.Link(tmpPath, target); err == nil {
			_ = os.Remove(tmpPath)
			return target, nil
		} else if os.IsExist(err) {
			target = nextAvailablePath(target)
			continue
		}

		out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if os.IsExist(err) {
			target = nextAvailablePath(target)
			continue
		}
		if err != nil {
			return target, err
		}
		in, err := os.Open(tmpPath)
		if err != nil {
			out.Close()
			_ = os.Remove(target)
			return target, err
		}
		_, copyErr := io.Copy(out, in)
		closeErr := out.Close()
		in.Close()
		if copyErr != nil {
			_ = os.Remove(target)
			return target, copyErr
		}
		if closeErr != nil {
			_ = os.Remove(target)
			return target, closeErr
		}
		_ = os.Remove(tmpPath)
		return target, nil
	}
	return target, fmt.Errorf("could not find an available target path")
}

func ShouldSkipURL(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == skipHost || strings.HasSuffix(host, "."+skipHost)
}

func SanitizeName(name string) string {
	name = invalidNameChars.Replace(strings.TrimSpace(name))
	name = strings.Trim(name, ". ")
	if len(name) > 180 {
		name = name[:180]
	}
	if name == "" {
		return "unnamed"
	}
	return name
}

func PickFilename(resp *http.Response, finalURL string, fallback string) string {
	if cd := resp.Header.Get("Content-Disposition"); cd != "" {
		if _, params, err := mime.ParseMediaType(cd); err == nil {
			if name := strings.TrimSpace(params["filename"]); name != "" {
				return SanitizeName(name)
			}
			if name := strings.TrimSpace(params["filename*"]); name != "" {
				return SanitizeName(name)
			}
		}
	}
	if u, err := url.Parse(finalURL); err == nil {
		if base := path.Base(u.Path); base != "." && strings.Contains(base, ".") {
			if unescaped, err := url.PathUnescape(base); err == nil {
				return SanitizeName(unescaped)
			}
			return SanitizeName(base)
		}
	}
	ct := strings.ToLower(strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0]))
	return SanitizeName(fallback) + contentTypeExt(ct)
}

func contentTypeExt(ct string) string {
	switch ct {
	case "audio/mpeg", "audio/mp3":
		return ".mp3"
	case "audio/flac", "audio/x-flac":
		return ".flac"
	case "audio/wav", "audio/x-wav":
		return ".wav"
	case "audio/ogg":
		return ".ogg"
	case "audio/mp4":
		return ".m4a"
	case "audio/aac":
		return ".aac"
	case "audio/webm":
		return ".webm"
	case "video/mp4":
		return ".mp4"
	case "video/quicktime":
		return ".mov"
	case "video/webm":
		return ".webm"
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "application/zip":
		return ".zip"
	}
	return ""
}

func apiTrackerExtraText(entry Entry) string {
	parts := []string{
		fieldString(entry.Fields, "extra"),
		fieldString(entry.Fields, "description"),
		fieldString(entry.Fields, "notes"),
		fieldString(entry.Raw, "extra"),
		fieldString(entry.Raw, "description"),
		fieldString(entry.Raw, "notes"),
	}
	for _, key := range []string{"extra", "description", "notes"} {
		parts = append(parts, strings.Join(fieldStrings(entry.LessCommonFields, key), " "))
	}
	return strings.Join(parts, " ")
}

func apiTrackerProducer(entry Entry) string {
	for _, key := range []string{"producer", "producers", "prod", "produced_by", "produced by"} {
		values := fieldStrings(entry.LessCommonFields, key)
		for i := range values {
			values[i] = strings.TrimSpace(apiTrackerProdRe.ReplaceAllString(values[i], ""))
		}
		if value := strings.Join(nonEmptyStrings(values), ", "); value != "" {
			return value
		}
	}
	return ""
}

func apiTrackerFeatured(entry Entry) []string {
	out := []string{}
	for _, key := range []string{"featured", "features", "feature", "feat", "feats", "featuring", "ft"} {
		for _, value := range fieldStrings(entry.LessCommonFields, key) {
			out = append(out, splitCreditNames(apiTrackerFeatRe.ReplaceAllString(value, ""))...)
		}
	}
	return dedupeStrings(out)
}

func parseTitleCredits(title string, extraText string) (cleanTitle string, producer string, altTitle string, featured []string) {
	cleanTitle = strings.TrimSpace(title)
	for _, m := range apiTrackerCreditGroupRe.FindAllStringSubmatch(title+" "+extraText, -1) {
		if len(m) < 2 {
			continue
		}
		group := strings.TrimSpace(m[1])
		if group == "" {
			continue
		}
		switch {
		case apiTrackerProdRe.MatchString(group):
			if producer == "" {
				producer = strings.TrimSpace(apiTrackerProdRe.ReplaceAllString(group, ""))
			}
			cleanTitle = strings.TrimSpace(strings.Replace(cleanTitle, m[0], "", 1))
		case apiTrackerFeatRe.MatchString(group):
			names := splitCreditNames(apiTrackerFeatRe.ReplaceAllString(group, ""))
			featured = append(featured, names...)
			cleanTitle = strings.TrimSpace(strings.Replace(cleanTitle, m[0], "", 1))
		case altTitle == "" && strings.Contains(title, m[0]):
			altTitle = group
		}
	}
	cleanTitle = strings.Join(strings.Fields(cleanTitle), " ")
	return cleanTitle, producer, altTitle, dedupeStrings(featured)
}

func splitCreditNames(raw string) []string {
	raw = strings.NewReplacer(
		"&", ",",
		" x ", ",",
		" X ", ",",
		" feat. ", ",",
		" feat ", ",",
		" ft. ", ",",
		" ft ", ",",
		" featuring ", ",",
	).Replace(raw)
	parts := strings.Split(raw, ",")
	out := []string{}
	for _, part := range parts {
		for _, name := range strings.Split(part, " and ") {
			name = strings.TrimSpace(name)
			if name != "" {
				out = append(out, name)
			}
		}
	}
	return out
}

func fieldStrings(fields map[string]any, key string) []string {
	if fields == nil {
		return nil
	}
	for k, value := range fields {
		if strings.EqualFold(strings.TrimSpace(k), key) {
			return valueStrings(value)
		}
	}
	return nil
}

func valueStrings(value any) []string {
	switch v := value.(type) {
	case nil:
		return nil
	case []string:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if item = strings.TrimSpace(item); item != "" {
				out = append(out, item)
			}
		}
		return out
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			out = append(out, valueStrings(item)...)
		}
		return out
	default:
		if s := anyString(v); s != "" {
			return []string{s}
		}
		return nil
	}
}

func dedupeStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := values[:0]
	for _, value := range values {
		key := strings.ToLower(strings.TrimSpace(value))
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, strings.TrimSpace(value))
	}
	return out
}

func nonEmptyStrings(values []string) []string {
	out := values[:0]
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			out = append(out, value)
		}
	}
	return out
}

func GuessPrimaryArtist(trackerName string) string {
	name := strings.TrimSpace(trackerName)
	for _, suffix := range []string{"Tracker", "Grid", "Sheet", "Spreadsheet", "List", "Leaks", "Archive", "Database"} {
		lowerName := strings.ToLower(name)
		lowerSuffix := strings.ToLower(suffix)
		if strings.HasSuffix(lowerName, " "+lowerSuffix) {
			return strings.TrimSpace(name[:len(name)-len(suffix)-1])
		}
		if strings.HasSuffix(lowerName, lowerSuffix) {
			return strings.TrimSpace(name[:len(name)-len(suffix)])
		}
	}
	return name
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func fieldString(fields map[string]any, key string) string {
	if fields == nil {
		return ""
	}
	if value := anyString(fields[key]); value != "" {
		return value
	}
	for k, value := range fields {
		if strings.EqualFold(k, key) {
			return anyString(value)
		}
	}
	return ""
}

func firstYear(values ...string) int {
	for _, value := range values {
		if y := ParseYear(value); y > 0 {
			return y
		}
	}
	return 0
}

var (
	yearPlainRe             = regexp.MustCompile(`\b(?:19|20)\d{2}\b`)
	apiTrackerCreditGroupRe = regexp.MustCompile(`\(([^()]+)\)`)
	apiTrackerProdRe        = regexp.MustCompile(`(?i)^(?:(?:prod|produced by)\.?)\s*`)
	apiTrackerFeatRe        = regexp.MustCompile(`(?i)^(?:(?:feat|ft|featuring|w/|with)\.?)\s*`)
)

func ParseYear(text string) int {
	if text == "" {
		return 0
	}
	if m := yearPlainRe.FindString(text); m != "" {
		if y, err := strconv.Atoi(m); err == nil {
			return y
		}
	}
	return 0
}

func (s *Scanner) tryBegin(id uuid.UUID) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inflight == nil {
		s.inflight = map[uuid.UUID]struct{}{}
	}
	if _, ok := s.inflight[id]; ok {
		return false
	}
	s.inflight[id] = struct{}{}
	return true
}

func (s *Scanner) end(id uuid.UUID) {
	s.mu.Lock()
	delete(s.inflight, id)
	s.mu.Unlock()
}
