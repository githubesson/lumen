package ingest

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/githubesson/lumen/internal/storage"
)

func TestStoreCoverImageRejectsUndecodableBytes(t *testing.T) {
	root := t.TempDir()
	svc := &Service{Storage: storage.NewLocal(root)}

	blob := bytes.Repeat([]byte{0xAB}, 1<<20)
	if key, err := svc.StoreCoverImage(context.Background(), blob, "image/jpeg"); err == nil {
		t.Fatalf("undecodable cover stored as %q", key)
	}
	if entries, _ := os.ReadDir(filepath.Join(root, "covers")); len(entries) != 0 {
		t.Fatalf("covers/ has %d entries after a rejected cover", len(entries))
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 4, 4))); err != nil {
		t.Fatal(err)
	}
	key, err := svc.StoreCoverImage(context.Background(), buf.Bytes(), "image/png")
	if err != nil || key == "" {
		t.Fatalf("valid cover: key=%q err=%v", key, err)
	}
}
