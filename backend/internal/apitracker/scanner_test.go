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

	"github.com/githubesson/lumen/internal/httpx"
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

func TestPinMatchesEntryTab(t *testing.T) {
	if !pinMatchesEntryTab(Pin{}, Entry{SheetName: "Leaks"}) {
		t.Fatal("blank pin tab should match every entry")
	}
	if !pinMatchesEntryTab(Pin{Tab: "leaks"}, Entry{SheetName: "Leaks"}) {
		t.Fatal("tab match should be case-insensitive")
	}
	if pinMatchesEntryTab(Pin{Tab: "Demos"}, Entry{SheetName: "Leaks"}) {
		t.Fatal("different tab should not match")
	}
}

func TestNormalizeEraKey(t *testing.T) {
	if got := normalizeEraKey("  Working   On Dying  "); got != "working on dying" {
		t.Fatalf("normalizeEraKey = %q", got)
	}
}

func TestBuildContextExtractsTitleCredits(t *testing.T) {
	ctx := BuildContext(
		Tracker{TrackerName: "Future Tracker"},
		Pin{},
		Entry{Name: "Chrome Heart Cross (feat. Gunna) (prod. Wheezy)", Era: "Mixtape", Type: "Leak"},
	)
	if ctx.Title != "Chrome Heart Cross" {
		t.Fatalf("Title = %q", ctx.Title)
	}
	if ctx.AlbumArtist != "Future" {
		t.Fatalf("AlbumArtist = %q", ctx.AlbumArtist)
	}
	if ctx.Artist != "Future feat. Gunna" {
		t.Fatalf("Artist = %q", ctx.Artist)
	}
	if len(ctx.Featured) != 1 || ctx.Featured[0] != "Gunna" {
		t.Fatalf("Featured = %#v", ctx.Featured)
	}
	if ctx.Composer != "Wheezy" {
		t.Fatalf("Composer = %q", ctx.Composer)
	}
}

func TestBuildContextExtractsCreditsFromExtraFields(t *testing.T) {
	ctx := BuildContext(
		Tracker{TrackerName: "Future Tracker"},
		Pin{},
		Entry{
			Name: "Too Comfortable",
			Fields: map[string]any{
				"extra": "(feat. Young Thug & Gunna) (prod. Wheezy)",
			},
		},
	)
	if ctx.Title != "Too Comfortable" {
		t.Fatalf("Title = %q", ctx.Title)
	}
	if got := strings.Join(ctx.Featured, ", "); got != "Young Thug, Gunna" {
		t.Fatalf("Featured = %#v", ctx.Featured)
	}
	if ctx.Composer != "Wheezy" {
		t.Fatalf("Composer = %q", ctx.Composer)
	}
}

func TestBuildContextUsesLessCommonCreditFields(t *testing.T) {
	ctx := BuildContext(
		Tracker{TrackerName: "Future Tracker"},
		Pin{},
		Entry{
			Name: "Too Comfortable (feat. Drake)",
			LessCommonFields: map[string]any{
				"producer":  "Wheezy",
				"featured":  []any{"Young Thug", "Gunna"},
				"extra":     "(prod. should not win)",
				"row_notes": "ignored",
			},
		},
	)
	if ctx.Title != "Too Comfortable" {
		t.Fatalf("Title = %q", ctx.Title)
	}
	if ctx.Composer != "Wheezy" {
		t.Fatalf("Composer = %q", ctx.Composer)
	}
	if got := strings.Join(ctx.Featured, ", "); got != "Young Thug, Gunna, Drake" {
		t.Fatalf("Featured = %#v", ctx.Featured)
	}
	if ctx.Artist != "Future feat. Young Thug, Gunna, Drake" {
		t.Fatalf("Artist = %q", ctx.Artist)
	}
}

func TestBuildContextUsesLessCommonProducerWithoutTitleCredits(t *testing.T) {
	ctx := BuildContext(
		Tracker{TrackerName: "Future Tracker"},
		Pin{},
		Entry{
			Name: "Solo",
			LessCommonFields: map[string]any{
				"produced_by": "Metro Boomin",
				"featuring":   "Don Toliver & Travis Scott",
			},
		},
	)
	if ctx.Title != "Solo" {
		t.Fatalf("Title = %q", ctx.Title)
	}
	if ctx.Composer != "Metro Boomin" {
		t.Fatalf("Composer = %q", ctx.Composer)
	}
	if got := strings.Join(ctx.Featured, ", "); got != "Don Toliver, Travis Scott" {
		t.Fatalf("Featured = %#v", ctx.Featured)
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
