package handlers

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"net/http"
	"time"
)

// The app icon is compiled into the binary so share cards can point at it
// without depending on the frontend's static files being served from the
// same origin. Discord's component embed uses it as the card's thumbnail.
//
//go:embed assets/lumen-icon.png
var lumenIconPNG []byte

// lumenIconPath is the unsigned public path of the embedded icon.
const lumenIconPath = "/api/public/brand/lumen-icon.png"

var lumenIconETag = func() string {
	sum := sha256.Sum256(lumenIconPNG)
	return `"` + hex.EncodeToString(sum[:8]) + `"`
}()

// PublicLumenIcon serves the embedded app icon.
func (h *Share) PublicLumenIcon(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("ETag", lumenIconETag)
	http.ServeContent(w, r, "lumen-icon.png", time.Time{}, bytes.NewReader(lumenIconPNG))
}
