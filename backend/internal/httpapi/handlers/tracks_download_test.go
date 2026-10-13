package handlers

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/githubesson/lumen/internal/downloadfile"
	"github.com/githubesson/lumen/internal/mediaembed"
)

// spoolFile writes data where streamTIDALDownload would have spooled the
// assembled track.
func spoolFile(t *testing.T, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "spool")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// A TIDAL download is tagged from the spooled file, so a failed remux can
// serve that same file untagged instead of fetching the track again.
func TestServeTaggedTIDAL(t *testing.T) {
	if !mediaembed.Available() {
		t.Skip("ffmpeg not available")
	}
	flac := filepath.Join(t.TempDir(), "in.flac")
	if out, err := exec.Command("ffmpeg", "-nostdin", "-v", "error",
		"-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=44100",
		"-t", "0.5", "-c:a", "flac", flac).CombinedOutput(); err != nil {
		t.Fatalf("generate flac: %v: %s", err, out)
	}
	audio, err := os.ReadFile(flac)
	if err != nil {
		t.Fatal(err)
	}
	h := &Tracks{}
	meta := mediaembed.Metadata{Title: "Spooled Title", Artist: "Someone"}

	t.Run("tagged", func(t *testing.T) {
		rec := httptest.NewRecorder()
		h.serveTaggedTIDAL(rec, httptest.NewRequest(http.MethodGet, "/", nil), "1", spoolFile(t, audio), "audio/flac", meta, nil)
		if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "audio/flac" {
			t.Fatalf("status=%d type=%q", rec.Code, rec.Header().Get("Content-Type"))
		}
		if !bytes.Contains(rec.Body.Bytes(), []byte("Spooled Title")) {
			t.Fatal("download is missing the embedded title")
		}
		if rec.Header().Get("Accept-Ranges") != "bytes" || rec.Header().Get("Cache-Control") != "private, max-age=0" {
			t.Fatalf("headers = %v", rec.Header())
		}
	})

	t.Run("remux fails", func(t *testing.T) {
		garbage := []byte("not audio at all")
		rec := httptest.NewRecorder()
		h.serveTaggedTIDAL(rec, httptest.NewRequest(http.MethodGet, "/", nil), "1", spoolFile(t, garbage), "audio/flac", meta, nil)
		if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), garbage) {
			t.Fatalf("status=%d body=%q, want the spooled file as is", rec.Code, rec.Body.String())
		}
		if rec.Header().Get("Content-Type") != "audio/flac" || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("headers = %v", rec.Header())
		}
	})

	t.Run("waits for a tag slot", func(t *testing.T) {
		for range cap(tagSlots) {
			tagSlots <- struct{}{}
		}
		defer func() {
			for range cap(tagSlots) {
				<-tagSlots
			}
		}()
		ctx, cancel := context.WithCancel(context.Background())
		cancel() // the client gives up while every slot is taken
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/", nil).WithContext(ctx)
		h.serveTaggedTIDAL(rec, req, "1", spoolFile(t, audio), "audio/flac", meta, nil)
		if rec.Body.Len() != 0 {
			t.Fatalf("served %d bytes without a tag slot", rec.Body.Len())
		}
	})
}

// An assembled TIDAL track past the download size limit is refused, not
// taken for a failure writing it to disk and streamed again with no limit.
func TestTIDALDownloadPastTheSizeLimitIsRefused(t *testing.T) {
	prev := downloadfile.MaxFileBytes
	downloadfile.MaxFileBytes = 8
	t.Cleanup(func() { downloadfile.MaxFileBytes = prev })
	// Asking TIDAL for the track again gets a refusal.
	h := &Tracks{TIDAL: refusingTIDAL(t, "asked again")}
	resp := &http.Response{
		Header: http.Header{"Content-Type": {"audio/flac"}},
		Body:   io.NopCloser(strings.NewReader("more than eight bytes")),
	}
	rec := httptest.NewRecorder()
	h.spoolTaggedTIDAL(rec, httptest.NewRequest(http.MethodGet, "/", nil), "1", resp, mediaembed.Metadata{Title: "T"}, nil)
	if rec.Code != http.StatusBadGateway || rec.Body.String() != "track too large\n" {
		t.Fatalf("status=%d body=%q", rec.Code, rec.Body.String())
	}
}
