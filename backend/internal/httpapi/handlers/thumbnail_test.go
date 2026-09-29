package handlers

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/githubesson/lumen/internal/storage"
)

func TestCoverPassthroughPreservesBytesAndThumbnailsKeepAspectRatio(t *testing.T) {
	for _, format := range []string{"jpeg", "png"} {
		t.Run(format, func(t *testing.T) {
			store := storage.NewLocal(t.TempDir())
			src := image.NewRGBA(image.Rect(0, 0, 192, 96))
			for y := 0; y < 96; y++ {
				for x := 0; x < 192; x++ {
					src.SetRGBA(x, y, color.RGBA{R: uint8(x), G: uint8(y), A: 180})
				}
			}
			var data bytes.Buffer
			var err error
			if format == "jpeg" {
				err = jpeg.Encode(&data, src, nil)
			} else {
				err = png.Encode(&data, src)
			}
			if err != nil {
				t.Fatal(err)
			}
			key := "covers/test." + format
			if _, err := store.Put(context.Background(), key, bytes.NewReader(data.Bytes()), int64(data.Len()), "image/"+format); err != nil {
				t.Fatal(err)
			}
			h := &Tracks{Storage: store}
			request := httptest.NewRequest(http.MethodGet, "/cover", nil)
			original := httptest.NewRecorder()
			h.serveStorageObject(original, request, key, 1024)
			if original.Code != http.StatusOK || !bytes.Equal(original.Body.Bytes(), data.Bytes()) {
				t.Fatalf("passthrough changed %s data: %d", format, original.Code)
			}
			thumb := httptest.NewRecorder()
			h.serveStorageObject(thumb, request, key, 64)
			cfg, _, err := image.DecodeConfig(thumb.Body)
			if err != nil || cfg.Width != 64 || cfg.Height != 32 {
				t.Fatalf("thumbnail dimensions = %+v, %v", cfg, err)
			}
			thumbKey, _ := thumbnailCacheKey(key, 64)
			cached, _, err := store.Get(context.Background(), thumbKey)
			if err != nil {
				t.Fatal(err)
			}
			want, err := io.ReadAll(cached)
			cached.Close()
			if err != nil {
				t.Fatal(err)
			}
			repeat := httptest.NewRecorder()
			h.serveStorageObject(repeat, request, key, 64)
			if !bytes.Equal(repeat.Body.Bytes(), want) {
				t.Fatal("cached thumbnail changed")
			}
		})
	}
}

func BenchmarkCoverPassthrough(b *testing.B) {
	store := storage.NewLocal(b.TempDir())
	var data bytes.Buffer
	if err := jpeg.Encode(&data, image.NewRGBA(image.Rect(0, 0, 1024, 1024)), nil); err != nil {
		b.Fatal(err)
	}
	key := "covers/benchmark.jpg"
	if _, err := store.Put(context.Background(), key, bytes.NewReader(data.Bytes()), int64(data.Len()), "image/jpeg"); err != nil {
		b.Fatal(err)
	}
	h := &Tracks{Storage: store}
	r := httptest.NewRequest(http.MethodGet, "/cover", nil)
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		h.serveStorageObject(httptest.NewRecorder(), r, key, 1024)
	}
}
