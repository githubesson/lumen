package filen

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/pathsafe"
	"github.com/githubesson/lumen/internal/pinscan"
)

type ScanSummary struct {
	PinID      uuid.UUID `json:"pin_id"`
	Seen       int       `json:"seen"`
	Downloaded int       `json:"downloaded"`
	Existing   int       `json:"existing"`
	Skipped    int       `json:"skipped"`
	Failed     int       `json:"failed"`
	Ingested   int       `json:"ingested"`
	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at"`
}

type Scanner struct {
	Store        *Store
	Ingest       *ingest.Service
	Library      *library.Store
	Logger       *slog.Logger
	PollInterval time.Duration
	FileTimeout  time.Duration
	NodePath     string
	ScriptPath   string

	mu       sync.Mutex
	inflight map[uuid.UUID]struct{}
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
		s.finish(id)
		return false, err
	}
	go func() {
		defer s.finish(id)
		if _, err := s.ScanPin(ctx, pin); err != nil && s.Logger != nil {
			s.Logger.Warn("filen manual scan failed", "pin", id, "err", err)
		}
	}()
	return true, nil
}

func (s *Scanner) scanDue(ctx context.Context) {
	pins, err := s.Store.DuePins(ctx, pinscan.DefaultScanBatch)
	if err != nil {
		if s.Logger != nil {
			s.Logger.Warn("filen due pins fetch failed", "err", err)
		}
		return
	}
	for _, pin := range pins {
		pin := pin
		if !s.tryBegin(pin.ID) {
			continue
		}
		go func() {
			defer s.finish(pin.ID)
			if _, err := s.ScanPin(ctx, pin); err != nil && s.Logger != nil {
				s.Logger.Warn("filen scheduled scan failed", "pin", pin.ID, "err", err)
			}
		}()
	}
}

func (s *Scanner) ScanPin(ctx context.Context, pin Pin) (ScanSummary, error) {
	summary := ScanSummary{PinID: pin.ID, StartedAt: time.Now().UTC()}
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
	summary.FinishedAt = time.Now().UTC()
	return summary, scanErr
}

func (s *Scanner) scanPin(ctx context.Context, pin Pin, summary *ScanSummary) error {
	destBase, err := pinDestination(pin)
	if err != nil {
		return err
	}
	runCtx, cancel := context.WithTimeout(ctx, s.FileTimeout)
	defer cancel()

	node := strings.TrimSpace(s.NodePath)
	if node == "" {
		node = "node"
	}
	script := strings.TrimSpace(s.ScriptPath)
	script, err = resolveScriptPath(script)
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(runCtx, node, script, "--json", "--password-env", "FILEN_SHARE_PASSWORD", pin.ShareURL, destBase)
	cmd.Env = append(
		os.Environ(),
		"FILEN_SHARE_PASSWORD="+pin.Password,
		"FILEN_ALLOWED_EXTENSIONS="+strings.Join(ingest.SupportedExtensions(), ","),
	)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}

	var stderrBuf bytes.Buffer
	stderrDone := make(chan struct{})
	go func() {
		_, _ = io.Copy(&stderrBuf, io.LimitReader(stderr, 32*1024))
		close(stderrDone)
	}()

	readErr := s.readEvents(ctx, pin, destBase, stdout, summary)
	waitErr := cmd.Wait()
	<-stderrDone
	if readErr != nil {
		return readErr
	}
	if waitErr != nil {
		detail := strings.TrimSpace(stderrBuf.String())
		if detail == "" {
			detail = waitErr.Error()
		}
		return fmt.Errorf("filen download failed: %s", detail)
	}
	if s.Logger != nil {
		s.Logger.Info("filen scan complete",
			"pin", pin.ID,
			"seen", summary.Seen,
			"downloaded", summary.Downloaded,
			"existing", summary.Existing,
			"skipped", summary.Skipped,
			"failed", summary.Failed)
	}
	return nil
}

type helperEvent struct {
	Event   string `json:"event"`
	Status  string `json:"status"`
	RelPath string `json:"relPath"`
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	Error   string `json:"error"`
}

func (s *Scanner) readEvents(ctx context.Context, pin Pin, destBase string, r io.Reader, summary *ScanSummary) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var ev helperEvent
		if err := json.Unmarshal(line, &ev); err != nil {
			continue
		}
		if ev.Event != "file" {
			continue
		}
		summary.Seen++
		sourcePath := strings.TrimSpace(ev.RelPath)
		if sourcePath == "" {
			sourcePath = filepath.Base(ev.Path)
		}
		status := normalizeStatus(ev.Status)
		if strings.TrimSpace(ev.Path) != "" {
			safePath, ok := helperPathInDestination(destBase, ev.Path)
			if !ok {
				status = StatusFailed
				ev.Path = ""
				if ev.Error == "" {
					ev.Error = "helper path escapes destination"
				}
			} else {
				ev.Path = safePath
			}
		}
		var trackID *uuid.UUID
		inserted := false
		if status == StatusDownloaded || status == StatusExisting {
			if ev.Path == "" {
				status = StatusFailed
				if ev.Error == "" {
					ev.Error = "helper did not provide file path"
				}
			} else if err := validateCompleteFile(ev.Path, ev.Size); err != nil {
				status = StatusFailed
				ev.Path = ""
				if ev.Error == "" {
					ev.Error = err.Error()
				}
			} else {
				trackID, inserted = s.ingestPath(ctx, ev.Path)
				if inserted {
					summary.Ingested++
				}
			}
		}
		switch status {
		case StatusDownloaded:
			summary.Downloaded++
		case StatusExisting:
			summary.Existing++
		case StatusSkipped:
			summary.Skipped++
		case StatusFailed:
			summary.Failed++
		}
		_ = s.Store.RecordDownload(ctx, DownloadInput{
			PinID:      pin.ID,
			SourcePath: sourcePath,
			FilePath:   ev.Path,
			SizeBytes:  ev.Size,
			Status:     status,
			Error:      ev.Error,
			TrackID:    trackID,
			Metadata:   eventMetadata(pin, ev),
		})
	}
	return sc.Err()
}

func helperPathInDestination(destBase, p string) (string, bool) {
	evPath, err := filepath.Abs(filepath.Clean(strings.TrimSpace(p)))
	if err != nil {
		return "", false
	}
	ok, err := pathsafe.WithinRoot(strings.TrimSpace(destBase), evPath)
	if err != nil || !ok {
		return "", false
	}
	return evPath, true
}

func normalizeStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case StatusDownloaded:
		return StatusDownloaded
	case StatusExisting:
		return StatusExisting
	case StatusSkipped:
		return StatusSkipped
	default:
		return StatusFailed
	}
}

func validateCompleteFile(p string, expectedSize int64) error {
	info, err := os.Stat(p)
	if err != nil {
		return fmt.Errorf("downloaded file unavailable: %w", err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("downloaded path is not a regular file")
	}
	if expectedSize > 0 && info.Size() != expectedSize {
		return fmt.Errorf("download size mismatch: expected %d bytes, got %d", expectedSize, info.Size())
	}
	if info.Size() <= 0 {
		return fmt.Errorf("downloaded file is empty")
	}
	return nil
}

func eventMetadata(pin Pin, ev helperEvent) json.RawMessage {
	b, err := json.Marshal(map[string]any{
		"share_url": pin.ShareURL,
		"rel_path":  ev.RelPath,
		"size":      ev.Size,
	})
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return b
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

func resolveScriptPath(configured string) (string, error) {
	candidates := []string{}
	if configured != "" {
		candidates = append(candidates, configured)
	}
	candidates = append(candidates,
		"filen-downloader/index.mjs",
		"/app/filen-downloader/index.mjs",
	)
	for _, cand := range candidates {
		if _, err := os.Stat(cand); err == nil {
			return cand, nil
		}
	}
	if configured != "" {
		return "", fmt.Errorf("filen downloader script not found at %s", configured)
	}
	return "", fmt.Errorf("filen downloader script not found")
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

func (s *Scanner) finish(id uuid.UUID) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.inflight, id)
}
