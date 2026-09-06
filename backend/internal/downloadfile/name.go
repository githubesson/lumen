package downloadfile

import (
	"mime"
	"net/http"
	"net/url"
	"path"
	"strings"
)

var invalidNameChars = strings.NewReplacer(
	"<", "_", ">", "_", ":", "_", `"`, "_", "/", "_", `\`, "_",
	"|", "_", "?", "_", "*", "_", "\n", "_", "\r", "_", "\t", "_",
)

func SanitizeName(name string) string {
	name = invalidNameChars.Replace(strings.TrimSpace(name))
	name = strings.Trim(name, ". ")
	if len(name) > 180 {
		name = name[:180]
	}
	if name == "" {
		return "unnamed"
	}
	return name
}

func PickFilename(resp *http.Response, finalURL string, fallback string) string {
	if cd := resp.Header.Get("Content-Disposition"); cd != "" {
		if _, params, err := mime.ParseMediaType(cd); err == nil {
			if name := strings.TrimSpace(params["filename"]); name != "" {
				return SanitizeName(name)
			}
			if name := strings.TrimSpace(params["filename*"]); name != "" {
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
	return SanitizeName(fallback) + contentTypeExt(ct)
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
