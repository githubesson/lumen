package handlers

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/models"
)

type Library struct {
	Ingest     *ingest.Service
	Library    *library.Store
	Background context.Context
	StartJob   func(func())

	mu     sync.Mutex
	rescan *ingest.RescanProgress
}

const (
	maxUploadBytes       int64 = 512 << 20
	maxUploadFileBytes   int64 = 512 << 20
	maxMultipartMemBytes int64 = 32 << 20
)

// log returns the handler's structured logger, falling back to the slog
// default so call sites never need a nil check.
func (h *Library) log() *slog.Logger {
	if h.Ingest != nil && h.Ingest.Logger != nil {
		return h.Ingest.Logger
	}
	return slog.Default()
}

// Upload accepts multipart audio files and ingests them. The `scope` form
// field picks the destination:
//
//   - scope=personal (default) — stored under MUSIC_ROOT/.users/<user-id>/,
//     owned by the uploader, only visible to them.
//   - scope=global — stored under MUSIC_ROOT/uploads/, part of the shared
//     library. Admin-only.
func (h *Library) Upload(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(maxMultipartMemBytes); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			h.log().Warn("upload rejected: body exceeds size limit",
				"user", u.ID, "limit_bytes", maxUploadBytes, "err", err)
			http.Error(w, "upload too large", http.StatusRequestEntityTooLarge)
			return
		}
		h.log().Warn("upload rejected: malformed multipart form", "user", u.ID, "err", err)
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	scope := strings.TrimSpace(r.FormValue("scope"))
	if scope == "" {
		scope = "personal"
	}
	var (
		ownerID *uuid.UUID
		destDir string
	)
	switch scope {
	case "global":
		if u.Role != models.RoleAdmin {
			h.log().Warn("upload rejected: non-admin requested global scope", "user", u.ID)
			http.Error(w, "admin required for global scope", http.StatusForbidden)
			return
		}
		destDir = filepath.Join(h.Ingest.MusicRoot, "uploads")
	case "personal":
		uid := u.ID
		ownerID = &uid
		destDir = filepath.Join(h.Ingest.MusicRoot, ".users", u.ID.String())
	default:
		h.log().Warn("upload rejected: invalid scope", "user", u.ID, "scope", scope)
		http.Error(w, "scope must be personal or global", http.StatusBadRequest)
		return
	}

	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		h.log().Warn("upload rejected: no files in request", "user", u.ID, "scope", scope)
		http.Error(w, "no files", http.StatusBadRequest)
		return
	}
	h.log().Info("upload starting",
		"user", u.ID, "scope", scope, "files", len(files), "dest_dir", destDir)

	type result struct {
		File     string `json:"file"`
		Inserted bool   `json:"inserted"`
		Dedup    bool   `json:"dedup,omitempty"`
		Skipped  bool   `json:"skipped,omitempty"`
		Error    string `json:"error,omitempty"`
		TrackID  string `json:"track_id,omitempty"`
	}
	results := make([]result, 0, len(files))

	for _, fh := range files {
		name := filepath.Base(fh.Filename)
		if !ingest.IsSupported(name) {
			results = append(results, result{File: fh.Filename, Skipped: true})
			continue
		}
		if fh.Size > maxUploadFileBytes {
			results = append(results, result{File: fh.Filename, Error: "file too large"})
			continue
		}
		if err := os.MkdirAll(destDir, 0o755); err != nil {
			h.log().Error("upload: could not create destination directory — check filesystem permissions on the music volume",
				"user", u.ID, "file", fh.Filename, "dir", destDir, "err", err)
			results = append(results, result{File: fh.Filename, Error: err.Error()})
			continue
		}
		src, err := fh.Open()
		if err != nil {
			h.log().Error("upload: could not open the uploaded file part",
				"user", u.ID, "file", fh.Filename, "err", err)
			results = append(results, result{File: fh.Filename, Error: err.Error()})
			continue
		}
		dst, _, copyErr := writeUniqueUpload(r.Context(), destDir, name, src, maxUploadFileBytes)
		_ = src.Close()
		if copyErr != nil {
			if errors.Is(copyErr, errFileTooLarge) {
				h.log().Warn("upload: file exceeds per-file size limit",
					"user", u.ID, "file", fh.Filename, "limit_bytes", maxUploadFileBytes)
				results = append(results, result{File: fh.Filename, Error: "file too large"})
				continue
			}
			h.log().Error("upload: writing the uploaded file to disk failed",
				"user", u.ID, "file", fh.Filename, "dst", dst, "err", copyErr)
			results = append(results, result{File: fh.Filename, Error: copyErr.Error()})
			continue
		}

		res := h.Ingest.IngestFileAs(r.Context(), dst, ownerID)
		rr := result{File: fh.Filename, Inserted: res.Inserted, Dedup: !res.Inserted && res.Err == nil, TrackID: res.TrackID.String()}
		if res.Err != nil {
			h.log().Error("upload: ingest failed after the file was written to disk",
				"user", u.ID, "file", fh.Filename, "dst", dst, "err", res.Err)
			rr.Error = res.Err.Error()
		}
		results = append(results, rr)
	}

	// Summary line: one glance at the logs shows whether an upload batch went
	// cleanly or partially failed, without grepping the per-file lines above.
	var inserted, dedup, skipped, failed int
	for _, rr := range results {
		switch {
		case rr.Error != "":
			failed++
		case rr.Skipped:
			skipped++
		case rr.Inserted:
			inserted++
		default:
			dedup++
		}
	}
	level := slog.LevelInfo
	if failed > 0 {
		level = slog.LevelWarn
	}
	h.log().Log(r.Context(), level, "upload finished",
		"user", u.ID, "scope", scope, "total", len(results),
		"inserted", inserted, "dedup", dedup, "skipped", skipped, "failed", failed)

	writeJSON(w, http.StatusOK, results)
}

// Rescan kicks off a full re-scan of the music directory in the background.
// Calling it while a scan is in progress returns 409.
func (h *Library) Rescan(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	if h.rescan != nil && !h.rescan.Done.Load() {
		h.mu.Unlock()
		http.Error(w, "rescan already in progress", http.StatusConflict)
		return
	}
	p := &ingest.RescanProgress{}
	h.rescan = p
	h.mu.Unlock()

	// Detach from the request: the handler returns immediately with 202, and
	// the goroutine needs a context that outlives the response. Keep request
	// values (for tracing) but drop the cancel signal.
	scanCtx := h.Background
	if scanCtx == nil {
		scanCtx = context.WithoutCancel(r.Context())
	}
	job := func() {
		_ = h.Ingest.Rescan(scanCtx, p)
	}
	if h.StartJob != nil {
		h.StartJob(job)
	} else {
		go job()
	}
	w.WriteHeader(http.StatusAccepted)
}

// RescanStatus returns the progress of the most recent rescan.
func (h *Library) RescanStatus(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	p := h.rescan
	h.mu.Unlock()
	if p == nil {
		writeJSON(w, http.StatusOK, map[string]any{"running": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"running":   !p.Done.Load(),
		"total":     p.Total.Load(),
		"processed": p.Processed.Load(),
		"inserted":  p.Inserted.Load(),
		"dedup":     p.Dedup.Load(),
		"errored":   p.Errored.Load(),
		"pruned":    p.Pruned.Load(),
	})
}

// Errors lists recent ingest failures.
func (h *Library) Errors(w http.ResponseWriter, r *http.Request) {
	errs, err := h.Library.ListIngestErrors(r.Context(), 200)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, errs)
}

// createUniqueUpload atomically reserves a destination name and returns the
// open file. O_EXCL is essential here: checking with Stat and opening later
// lets concurrent uploads choose and truncate the same path.
func createUniqueUpload(dir, name string) (string, *os.File, error) {
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 0; i < 10000; i++ {
		candidateName := name
		if i > 0 {
			candidateName = base + "-" + itoa(i) + ext
		}
		candidate := filepath.Join(dir, candidateName)
		f, err := os.OpenFile(candidate, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			return candidate, f, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return "", nil, err
		}
	}
	return "", nil, os.ErrExist
}

// writeUniqueUpload owns cleanup of the exclusively-created destination. A
// short read, write failure, close failure, size violation, or cancellation
// cannot leave a partial file behind for a later rescan to ingest.
func writeUniqueUpload(ctx context.Context, dir, name string, src io.Reader, maxBytes int64) (string, int64, error) {
	if err := ctx.Err(); err != nil {
		return "", 0, err
	}
	dst, out, err := createUniqueUpload(dir, name)
	if err != nil {
		return "", 0, err
	}
	written, copyErr := copyFileLimited(out, &contextReader{ctx: ctx, r: src}, maxBytes)
	if copyErr == nil {
		copyErr = ctx.Err()
	}
	if closeErr := out.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr == nil {
		copyErr = ctx.Err()
	}
	if copyErr != nil {
		_ = os.Remove(dst)
		return "", written, copyErr
	}
	return dst, written, nil
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(buf[pos:])
}
