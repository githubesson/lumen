package handlers

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"unicode"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/library"
)

// PublicPreviewAudio serves a share snippet's audio as a standalone M4A — the
// "Download audio" option on the share page and the Discord card. It is
// remuxed from the same preview MP4, so the audio and video downloads always
// match. Two URL forms reach it: the hourly-rotating exp+sig form PublicInfo
// hands the browser, and the long-lived share-signed form (no exp) that
// mirrors PublicPreviewVideo for surfaces that keep URLs indefinitely.
func (h *Share) PublicPreviewAudio(w http.ResponseWriter, r *http.Request) {
	withExpiry := r.URL.Query().Has("exp")
	req, ok := h.parseSignedMediaRequest(w, r, withExpiry)
	if !ok || !h.requirePublicTrack(w, r, req.id, "preview audio serve") {
		return
	}
	id := req.id.String()
	outPath, cached := h.Preview.CachedAudio(id, req.startSec, req.durationSec)
	if !cached {
		videoPath, ok := h.Preview.CachedPreview(id, req.startSec, req.durationSec)
		if !ok {
			t, ok := h.loadPublicTrack(w, r, req.id, "preview audio serve")
			if !ok {
				return
			}
			var err error
			videoPath, err = h.buildPublicPreview(r, t, req, "preview audio serve")
			if err != nil {
				writePublicBuildError(w, err, "preview generation failed")
				return
			}
		}
		key := publicBuildKey("audio", id, req.startSec, req.durationSec)
		var err error
		outPath, err = buildPublicMedia(r, key, func(ctx context.Context) (string, error) {
			out, err := h.Preview.EnsureAudioBuilt(ctx, id, req.startSec, req.durationSec, videoPath)
			if err != nil {
				slog.Error("preview audio serve: EnsureAudioBuilt failed",
					"track_id", id, "start_sec", req.startSec, "err", err)
			}
			return out, err
		})
		if err != nil {
			writePublicBuildError(w, err, "audio generation failed")
			return
		}
	}
	cacheControl := "public, max-age=3600"
	if withExpiry {
		cacheControl = immutableCacheControl(req.exp)
	}
	if wantsDownload(r) {
		h.setClipAttachment(w, r, req.id, ".m4a")
	}
	serveFileAs(w, r, outPath, "audio/mp4", "audio missing", cacheControl)
}

// wantsDownload reports whether a signed media URL carries the ?download flag
// (see downloadURL).
func wantsDownload(r *http.Request) bool {
	return r.URL.Query().Has("download")
}

// setClipAttachment sets Content-Disposition so the browser saves the clip
// under "Artist - Title (clip).ext", the name the share page's own download
// menu uses. Call it only once the file is ready to serve, so an error
// response never arrives as a download. A failed track lookup still produces
// a download, just with a generic name: the signature already authorized the
// bytes.
func (h *Share) setClipAttachment(w http.ResponseWriter, r *http.Request, id uuid.UUID, ext string) {
	var t *library.TrackDetail
	if h.Library != nil {
		t, _ = h.Library.GetTrackPublic(r.Context(), id)
	}
	w.Header().Set("Content-Disposition", attachmentDisposition(clipFilename(t)+ext))
}

// clipFilename mirrors core's shareClipName: "Artist - Title (clip)".
func clipFilename(t *library.TrackDetail) string {
	var artist, title string
	if t != nil {
		artist = strings.TrimSpace(primaryArtistName(t))
		title = strings.TrimSpace(t.Title)
	}
	if title == "" {
		title = "Lumen"
	}
	name := title + " (clip)"
	if artist != "" {
		name = artist + " - " + name
	}
	return sanitizeFilename(name)
}

// sanitizeFilename mirrors core's sanitizeFilename: strips the characters no
// common filesystem accepts, collapses whitespace, and bounds the length.
func sanitizeFilename(name string) string {
	var b strings.Builder
	b.Grow(len(name))
	for _, r := range name {
		switch {
		case r < 0x20, strings.ContainsRune(`<>:"/\|?*`, r):
			b.WriteByte('_')
		case unicode.IsSpace(r):
			b.WriteByte(' ')
		default:
			b.WriteRune(r)
		}
	}
	out := strings.Join(strings.Fields(b.String()), " ")
	out = strings.TrimRight(out, ". ")
	if runes := []rune(out); len(runes) > 180 {
		out = strings.TrimRight(string(runes[:180]), ". ")
	}
	if out == "" {
		out = "Lumen (clip)"
	}
	return out
}

// attachmentDisposition builds a Content-Disposition that every browser
// decodes: an ASCII filename= for old clients and, when the name has
// non-ASCII runes, an RFC 8187 filename*= carrying the real name.
func attachmentDisposition(filename string) string {
	ascii := strings.Map(func(r rune) rune {
		if r > unicode.MaxASCII || r == '"' || r == '\\' {
			return '_'
		}
		return r
	}, filename)
	out := `attachment; filename="` + ascii + `"`
	if ascii != filename {
		out += "; filename*=UTF-8''" + rfc8187Encode(filename)
	}
	return out
}

// rfc8187Encode percent-encodes everything outside RFC 8187's attr-char set.
func rfc8187Encode(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	b.Grow(len(s) * 3)
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case 'a' <= c && c <= 'z', 'A' <= c && c <= 'Z', '0' <= c && c <= '9':
			b.WriteByte(c)
		case strings.IndexByte("!#$&+-.^_`|~", c) >= 0:
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&0x0f])
		}
	}
	return b.String()
}

func signedPreviewAudioURL(base string, id uuid.UUID, startSec, durationSec int, exp int64, sig string) string {
	url := signedPreviewMediaURL(base, "/api/public/preview-audio/", id, startSec, durationSec, exp, sig)
	// signedPreviewMediaURL always names the file .mp4.
	return strings.Replace(url, id.String()+".mp4?", id.String()+".m4a?", 1)
}
