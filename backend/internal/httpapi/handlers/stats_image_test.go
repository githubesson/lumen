package handlers

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"os"
	"testing"

	"github.com/google/uuid"
)

func TestReplayCoverPathMaterializesRemoteTIDALArtwork(t *testing.T) {
	resetCoverCache(t)
	oldClient := remoteCoverHTTPClient
	t.Cleanup(func() { remoteCoverHTTPClient = oldClient })

	var cover bytes.Buffer
	coverImage := image.NewRGBA(image.Rect(0, 0, 2, 2))
	coverImage.SetRGBA(0, 0, color.RGBA{R: 255, A: 255})
	if err := png.Encode(&cover, coverImage); err != nil {
		t.Fatalf("encode test cover: %v", err)
	}
	coverBytes := cover.Bytes()
	target := "https://resources.tidal.com/images/aa/bb/cc/640x640.jpg"
	remoteCoverHTTPClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode:    http.StatusOK,
				Status:        "200 OK",
				Header:        http.Header{"Content-Type": []string{"image/png"}},
				Body:          io.NopCloser(bytes.NewReader(coverBytes)),
				ContentLength: int64(len(coverBytes)),
				Request:       req,
			}, nil
		}),
	}

	path, cleanup := (&Stats{}).replayCoverPath(context.Background(), uuid.New(), nil, target)
	if path == "" {
		t.Fatal("replayCoverPath() returned no path for TIDAL artwork")
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open materialized cover: %v", err)
	}
	if _, _, err := image.Decode(f); err != nil {
		_ = f.Close()
		t.Fatalf("decode materialized cover: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close materialized cover: %v", err)
	}

	cleanup()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("cleanup left materialized cover at %q", path)
	}
}
