package apitracker

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/uncut/lumen/internal/httpx"
)

func TestDownloadOneSkipsUnsupportedExtensionBeforeWriting(t *testing.T) {
	var requested bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested = true
		w.Header().Set("Content-Disposition", `attachment; filename="notes.txt"`)
		_, _ = w.Write([]byte("not audio"))
	}))
	defer srv.Close()

	scanner := Scanner{
		FileTimeout:       time.Second,
		downloadURLPolicy: httpx.DownloadPolicy{AllowLoopback: true},
	}
	status, resolved, filePath, _, _, err := scanner.downloadOne(
		context.Background(),
		NewClient(""),
		Pin{},
		t.TempDir(),
		Entry{Era: "era", Type: "category"},
		"fallback",
		srv.URL,
		TrackContext{Album: "era", Genre: "category"},
	)
	if status != "" {
		t.Fatalf("expected no download status, got %q", status)
	}
	if resolved != srv.URL {
		t.Fatalf("resolved URL mismatch: %q", resolved)
	}
	if filePath == "" || filepath.Ext(filePath) != ".txt" {
		t.Fatalf("expected skipped txt target path, got %q", filePath)
	}
	var skipErr skipDownloadError
	if !errors.As(err, &skipErr) {
		t.Fatalf("expected skipDownloadError, got %T %v", err, err)
	}
	if skipErr.Error() != "unsupported file extension" {
		t.Fatalf("unexpected skip reason: %q", skipErr.Error())
	}
	if !requested {
		t.Fatal("server was not requested")
	}
	if _, statErr := os.Stat(filePath); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("unsupported file should not be written, stat err: %v", statErr)
	}
}

func TestDownloadOneRejectsLoopbackByDefaultBeforeRequest(t *testing.T) {
	var requested bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested = true
		_, _ = w.Write([]byte("should not be requested"))
	}))
	defer srv.Close()

	scanner := Scanner{FileTimeout: time.Second}
	status, resolved, filePath, _, _, err := scanner.downloadOne(
		context.Background(),
		NewClient(""),
		Pin{},
		t.TempDir(),
		Entry{},
		"fallback.mp3",
		srv.URL,
		TrackContext{Album: "era", Genre: "category"},
	)
	if status != "" || filePath != "" {
		t.Fatalf("expected no status/path, got status=%q path=%q", status, filePath)
	}
	if resolved != srv.URL {
		t.Fatalf("resolved URL mismatch: %q", resolved)
	}
	var skipErr skipDownloadError
	if !errors.As(err, &skipErr) {
		t.Fatalf("expected skipDownloadError, got %T %v", err, err)
	}
	if requested {
		t.Fatal("loopback server was requested")
	}
}

func TestDownloadOneRedactsNon2xxResponseBody(t *testing.T) {
	const secretBody = "SECRET_TOKEN_FROM_HOST"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, secretBody, http.StatusTeapot)
	}))
	defer srv.Close()

	scanner := Scanner{
		FileTimeout:       time.Second,
		downloadURLPolicy: httpx.DownloadPolicy{AllowLoopback: true},
	}
	_, _, _, _, _, err := scanner.downloadOne(
		context.Background(),
		NewClient(""),
		Pin{},
		t.TempDir(),
		Entry{},
		"fallback.mp3",
		srv.URL,
		TrackContext{Album: "era", Genre: "category"},
	)
	if err == nil {
		t.Fatal("expected non-2xx download to fail")
	}
	if strings.Contains(err.Error(), secretBody) {
		t.Fatalf("non-2xx body leaked into error: %v", err)
	}
	if !strings.Contains(err.Error(), "download 418 I'm a teapot") {
		t.Fatalf("expected status-only download error, got: %v", err)
	}
}
