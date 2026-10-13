package downloadfile

import (
	"mime"
	"net/http"
	"net/url"
	"path"
	"strings"
	"unicode/utf8"
)

var invalidNameChars = strings.NewReplacer(
	"<", "_", ">", "_", ":", "_", `"`, "_", "/", "_", `\`, "_",
	"|", "_", "?", "_", "*", "_", "\n", "_", "\r", "_", "\t", "_",
)

// maxNameBytes caps a sanitized name, leaving room under the usual 255-byte
// filesystem limit for the "-N" and temp-file affixes Save adds.
const maxNameBytes = 180

// maxExtBytes bounds what counts as an extension when a long name is cut, so
// "Mr. Brightside (Demo)" isn't read as having a ". Brightside (Demo)" one.
const maxExtBytes = 16

// SanitizeName makes name safe as one path component: valid UTF-8, no path
// separators or reserved characters, no leading or trailing dots and spaces,
// and at most maxNameBytes. A long name loses the end of its stem, cut on a
// rune boundary, and keeps its extension, which the downloaders filter on.
func SanitizeName(name string) string {
	name = strings.ToValidUTF8(name, "")
	name = invalidNameChars.Replace(strings.TrimSpace(name))
	name = strings.Trim(name, ". ")
	if len(name) > maxNameBytes {
		ext := path.Ext(name)
		if len(ext) > maxExtBytes || strings.Contains(ext, " ") {
			ext = ""
		}
		stem := truncateUTF8(strings.TrimSuffix(name, ext), maxNameBytes-len(ext))
		name = strings.TrimRight(stem, ". ") + ext
	}
	if name == "" {
		return "unnamed"
	}
	return name
}

// truncateUTF8 cuts s to at most max bytes without splitting a rune.
func truncateUTF8(s string, max int) string {
	if len(s) <= max {
		return s
	}
	for max > 0 && !utf8.RuneStart(s[max]) {
		max--
	}
	return s[:max]
}

func PickFilename(resp *http.Response, finalURL string, fallback string) string {
	if cd := resp.Header.Get("Content-Disposition"); cd != "" {
		if _, params, err := mime.ParseMediaType(cd); err == nil {
			// ParseMediaType decodes an RFC 2231 filename* into "filename".
			if name := strings.TrimSpace(params["filename"]); name != "" {
				return SanitizeName(name)
			}
		}
	}
	if u, err := url.Parse(finalURL); err == nil {
		if base := path.Base(u.Path); base != "." && strings.Contains(base, ".") {
			if unescaped, err := url.PathUnescape(base); err == nil {
				return SanitizeName(unescaped)
			}
			return SanitizeName(base)
		}
	}
	ct := strings.ToLower(strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0]))
	// Sanitized again so the extension counts toward the length cap.
	return SanitizeName(SanitizeName(fallback) + contentTypeExt(ct))
}

func contentTypeExt(ct string) string {
	switch ct {
	case "audio/mpeg", "audio/mp3":
		return ".mp3"
	case "audio/flac", "audio/x-flac":
		return ".flac"
	case "audio/wav", "audio/x-wav":
		return ".wav"
	case "audio/ogg":
		return ".ogg"
	case "audio/mp4":
		return ".m4a"
	case "audio/aac":
		return ".aac"
	case "audio/webm":
		return ".webm"
	case "video/mp4":
		return ".mp4"
	case "video/quicktime":
		return ".mov"
	case "video/webm":
		return ".webm"
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "application/zip":
		return ".zip"
	}
	return ""
}
