package handlers

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/trackref"
)

func TestAllowedRemoteCoverURLOnlyAllowsTIDALResources(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{
			name: "tidal resources https",
			raw:  "https://resources.tidal.com/images/aa/bb/cc/640x640.jpg",
		},
		{
			name:    "tidal resources http",
			raw:     "http://resources.tidal.com/images/aa/bb/cc/640x640.jpg",
			wantErr: true,
		},
		{
			name:    "other tidal host",
			raw:     "https://listen.tidal.com/images/aa/bb/cc/640x640.jpg",
			wantErr: true,
		},
		{
			name:    "other host",
			raw:     "https://example.com/cover.jpg",
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := allowedRemoteCoverURL(tt.raw)
			if (err != nil) != tt.wantErr {
				t.Fatalf("allowedRemoteCoverURL() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestRemoteCoverURLForSizePrefersStoredCoverURL(t *testing.T) {
	got := remoteCoverURLForSize(library.RemoteCover{
		Source:   trackref.SourceTIDAL,
		CoverID:  "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		CoverURL: "https://resources.tidal.com/images/aa/bb/cc/640x640.jpg",
	}, 1024)
	if got != "https://resources.tidal.com/images/aa/bb/cc/640x640.jpg" {
		t.Fatalf("remoteCoverURLForSize() = %q, want stored cover_url", got)
	}
}

func TestRemoteCoverURLForSizeDerivesKnownTIDALSize(t *testing.T) {
	got := remoteCoverURLForSize(library.RemoteCover{
		Source:  trackref.SourceTIDAL,
		CoverID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
	}, 1024)
	if !strings.HasSuffix(got, "/1280x1280.jpg") {
		t.Fatalf("remoteCoverURLForSize() = %q, want hifi-api known size", got)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestServeRemoteCoverFetchesTIDALArtworkWithBrowserHeaders(t *testing.T) {
	oldClient := remoteCoverHTTPClient
	defer func() { remoteCoverHTTPClient = oldClient }()

	target := "https://resources.tidal.com/images/aa/bb/cc/640x640.jpg"
	remoteCoverHTTPClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if req.URL.String() != target {
				t.Fatalf("remote cover request URL = %q, want %q", req.URL.String(), target)
			}
			if got := req.Header.Get("User-Agent"); got == "" {
				t.Fatalf("remote cover request missing User-Agent")
			}
			if got := req.Header.Get("Accept"); !strings.Contains(got, "image/") {
				t.Fatalf("remote cover request Accept = %q, want image accept", got)
			}
			if got := req.Header.Get("Referer"); got != "https://tidal.com/" {
				t.Fatalf("remote cover request Referer = %q, want tidal referer", got)
			}
			return &http.Response{
				StatusCode:    http.StatusOK,
				Status:        "200 OK",
				Header:        http.Header{"Content-Type": []string{"image/jpeg"}},
				Body:          io.NopCloser(strings.NewReader("jpg")),
				ContentLength: 3,
				Request:       req,
			}, nil
		}),
	}
	req := httptest.NewRequest(http.MethodGet, "/api/albums/test/cover", nil)
	rec := httptest.NewRecorder()

	(&Tracks{}).serveRemoteCover(rec, req, target)

	if rec.Code != http.StatusOK {
		t.Fatalf("serveRemoteCover() status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Content-Type"); got != "image/jpeg" {
		t.Fatalf("serveRemoteCover() Content-Type = %q, want image/jpeg", got)
	}
	if got := rec.Body.String(); got != "jpg" {
		t.Fatalf("serveRemoteCover() body = %q, want image bytes", got)
	}
}

func TestServeRemoteCoverRedirectsWhenBackendFetchIsBlocked(t *testing.T) {
	oldClient := remoteCoverHTTPClient
	defer func() { remoteCoverHTTPClient = oldClient }()

	target := "https://resources.tidal.com/images/aa/bb/cc/640x640.jpg"
	remoteCoverHTTPClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusForbidden,
				Status:     "403 Forbidden",
				Body:       io.NopCloser(strings.NewReader("forbidden")),
				Request:    req,
			}, nil
		}),
	}
	req := httptest.NewRequest(http.MethodGet, "/api/albums/test/cover", nil)
	rec := httptest.NewRecorder()

	(&Tracks{}).serveRemoteCover(rec, req, target)

	if rec.Code != http.StatusFound {
		t.Fatalf("serveRemoteCover() status = %d, want %d", rec.Code, http.StatusFound)
	}
	if got := rec.Header().Get("Location"); got != target {
		t.Fatalf("serveRemoteCover() Location = %q, want %q", got, target)
	}
}
