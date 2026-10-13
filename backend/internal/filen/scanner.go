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
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/downloadfile"
	"github.com/githubesson/lumen/internal/ffsafe"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/musicroots"
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

// Fallback per-file download deadline when *_FILE_TIMEOUT is unset or <= 0.
const defaultFileTimeout = 30 * time.Minute

// Variables only so tests can lower them.
var (
	// helperIdleGrace is added to the per-file timeout, which the helper
	// enforces on each download, for the work around one: listing, checking
	// and installing it.
	helperIdleGrace = 5 * time.Minute
	// helperStopGrace is how long a helper sent SIGTERM gets to delete its
	// partial download and exit before it is killed.
	helperStopGrace = 10 * time.Second
)

type Scanner struct {
	Store        *Store
	Ingest       *ingest.Service
	Library      *library.Store
	Roots        *musicroots.Store
	Logger       *slog.Logger
	PollInterval time.Duration
	FileTimeout  time.Duration
	NodePath     string
	ScriptPath   string

	scans pinscan.Group
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
	s.scans.Go(id, "filen manual scan", func() {
		if _, err := s.ScanPin(ctx, pin); err != nil && s.Logger != nil {
			s.Logger.Warn("filen manual scan failed", "pin", id, "err", err)
		}
	})
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
		if !s.scans.TryBegin(pin.ID) {
			continue
		}
		s.scans.Go(pin.ID, "filen scheduled scan", func() {
			if _, err := s.ScanPin(ctx, pin); err != nil && s.Logger != nil {
				s.Logger.Warn("filen scheduled scan failed", "pin", pin.ID, "err", err)
			}
		})
	}
}

// Wait blocks until all scheduled and manually-triggered scans have stopped.
// Call it after Run has returned so no new jobs can be added.
func (s *Scanner) Wait() { s.scans.Wait() }

func (s *Scanner) ScanPin(ctx context.Context, pin Pin) (ScanSummary, error) {
	summary := ScanSummary{PinID: pin.ID, StartedAt: time.Now().UTC()}
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

// fileTimeout reads the configured per-file deadline, falling back to the
// default without writing it back: ScanPin runs concurrently (scanDue fans out
// one goroutine per due pin while StartPinScan adds more from the admin
// handler), so that was an unsynchronized write to shared state. The helper
// enforces it on each download; scanPin stops a helper that goes quiet for
// longer, rather than bounding the whole share by it.
func (s *Scanner) fileTimeout() time.Duration {
	if s.FileTimeout > 0 {
		return s.FileTimeout
	}
	return defaultFileTimeout
}

func (s *Scanner) scanPin(ctx context.Context, pin Pin, summary *ScanSummary) error {
	destBase, err := pinscan.Destination(ctx, s.Roots, pin.RootID, pin.RootPath, pin.DestinationSubdir)
	if err != nil {
		return err
	}
	runCtx, cancel := context.WithCancel(ctx)
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
	// Re-validate here as well as at the API boundary: pins created before the
	// check existed are still in the database, and `--` only stops the helper
	// from reading a leading-dash URL as an option, not from being handed
	// nonsense.
	shareURL, err := ValidateShareURL(pin.ShareURL)
	if err != nil {
		return err
	}
	retained, err := s.Store.retainedFiles(runCtx, pin.ID)
	if err != nil {
		return fmt.Errorf("load filen download history: %w", err)
	}
	manifest, err := json.Marshal(retained)
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(runCtx, node, script, "--json", "--retained-stdin", "--password-env", "FILEN_SHARE_PASSWORD", "--", shareURL, destBase)
	cmd.Stdin = bytes.NewReader(manifest)
	cmd.Env = append(
		helperEnv(os.Environ()),
		"FILEN_SHARE_PASSWORD="+pin.Password,
		"FILEN_ALLOWED_EXTENSIONS="+strings.Join(ingest.SupportedExtensions(), ","),
		"FILEN_MAX_FILE_BYTES="+strconv.FormatInt(downloadfile.MaxFileBytes, 10),
		"FILEN_FILE_TIMEOUT_MS="+strconv.FormatInt(s.fileTimeout().Milliseconds(), 10),
	)
	// SIGTERM, not the default SIGKILL, so the helper can delete the partial
	// file of the download in progress; WaitDelay kills it if it hangs.
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = helperStopGrace

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	// Read stderr to the end, keeping its tail for the error: a helper whose
	// stderr goes unread can't finish writing it, so it stalls and is killed,
	// leaving its partial file, instead of finishing the share. exec copies
	// into the tail itself, and Wait returns only once that copy has the
	// helper's last words (or WaitDelay gives up on it).
	stderrTail := ffsafe.NewTail(32 * 1024)
	cmd.Stderr = stderrTail
	if err := cmd.Start(); err != nil {
		return err
	}

	// The helper reports each file as it finishes it. One quiet for longer
	// than a file may take is stuck (in a listing, say), so stop it. The
	// clock only runs while waiting on the helper, not while ingesting.
	idle := s.fileTimeout() + helperIdleGrace
	var stalled atomic.Bool
	watchdog := time.AfterFunc(idle, func() {
		stalled.Store(true)
		cancel()
	})
	defer watchdog.Stop()

	// runCtx, not ctx: the helper process is bounded by runCtx, so ingesting
	// its events under the wider context would outlive the process producing
	// them.
	readErr := s.readEvents(runCtx, pin, destBase, idleReader{stdout, watchdog, idle}, summary, retained)
	if readErr != nil {
		// Stop the helper when event validation fails; nobody is draining
		// stdout now, so waiting for normal completion could block.
		cancel()
	}
	waitErr := cmd.Wait()
	// A stalled helper was stopped by the watchdog; whatever reading its
	// output then failed with (a pipe closed under it) follows from that.
	if stalled.Load() {
		return fmt.Errorf("filen download stalled: no progress for %s", idle)
	}
	if readErr != nil {
		return readErr
	}
	if waitErr != nil {
		detail := strings.TrimSpace(stderrTail.String())
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

// idleReader runs timer only while a Read waits on the helper, so time spent
// ingesting what it already sent doesn't count.
type idleReader struct {
	r     io.Reader
	timer *time.Timer
	idle  time.Duration
}

func (r idleReader) Read(p []byte) (int, error) {
	r.timer.Reset(r.idle)
	n, err := r.r.Read(p)
	r.timer.Stop()
	return n, err
}

type helperEvent struct {
	Retained bool   `json:"retained"`
	Event    string `json:"event"`
	Status   string `json:"status"`
	RelPath  string `json:"relPath"`
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	Error    string `json:"error"`
}

func (s *Scanner) readEvents(ctx context.Context, pin Pin, destBase string, r io.Reader, summary *ScanSummary, retained map[string]retainedFile) error {
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
		if ev.Retained {
			// Only trust paths supplied by our database manifest. A canonical
			// file can live outside this pin's destination; never ingest it
			// again or replace its metadata with this source's metadata.
			file, ok := retained[sourcePath]
			if !ok || status != StatusExisting || file.Size != ev.Size {
				return fmt.Errorf("invalid retained file event for %q", sourcePath)
			}
			if err := validateCompleteFile(file.Path, file.FileSize); err != nil {
				return err
			}
			summary.Existing++
			continue
		}
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
