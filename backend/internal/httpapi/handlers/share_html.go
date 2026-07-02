package handlers

import (
	"encoding/json"
	"html"
	"strconv"
	"strings"
	"time"

	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/preview"
)

func primaryArtistName(t *library.TrackDetail) string {
	// Prefer the artist marked "primary"; fall back to the first artist
	// regardless of role, so composer-only tracks still have *something*
	// in the Discord card instead of a blank subtitle.
	for _, a := range t.Artists {
		if a.Role == "primary" {
			return a.Name
		}
	}
	if len(t.Artists) > 0 {
		return t.Artists[0].Name
	}
	return ""
}

type shareMeta struct {
	Title       string
	Description string
	Artist      string
	Album       string
	Canonical   string
	CoverURL    string
	VideoURL    string
	ThemeColor  string
	Landing     string
}

// renderSharePage writes the scraper-facing HTML. Minimal on purpose: the
// only audience that matters for styling is Discord / Twitter / Slack
// crawlers, and they only read the <meta> tags in <head>. Humans get a
// meta-refresh to the app (with a plain anchor as a fallback).
func renderSharePage(m shareMeta) string {
	var b strings.Builder
	b.Grow(2048)
	b.WriteString("<!doctype html>\n<html lang=\"en\">\n<head>\n")
	b.WriteString(`<meta charset="utf-8">`)
	b.WriteString(`<meta name="viewport" content="width=device-width,initial-scale=1">`)
	writeTitleTag(&b, m.Title, m.Artist)
	writeMetaName(&b, "description", m.Description)
	writeMetaName(&b, "theme-color", m.ThemeColor)

	// Open Graph — the primary surface.
	writeMetaProp(&b, "og:site_name", "Lumen")
	writeMetaProp(&b, "og:type", "video.other")
	writeMetaProp(&b, "og:title", m.Title)
	writeMetaProp(&b, "og:description", m.Description)
	writeMetaProp(&b, "og:url", m.Canonical)
	if m.CoverURL != "" {
		writeMetaProp(&b, "og:image", m.CoverURL)
		writeMetaProp(&b, "og:image:secure_url", m.CoverURL)
		writeMetaProp(&b, "og:image:width", "720")
		writeMetaProp(&b, "og:image:height", "720")
	}
	writeMetaProp(&b, "og:video", m.VideoURL)
	writeMetaProp(&b, "og:video:url", m.VideoURL)
	writeMetaProp(&b, "og:video:secure_url", m.VideoURL)
	writeMetaProp(&b, "og:video:type", "video/mp4")
	writeMetaProp(&b, "og:video:width", "720")
	writeMetaProp(&b, "og:video:height", "720")
	writeMetaProp(&b, "og:video:duration", strconv.Itoa(int(preview.PreviewDuration/time.Second)))
	if m.Artist != "" {
		writeMetaProp(&b, "music:musician", m.Artist)
	}
	if m.Album != "" {
		writeMetaProp(&b, "music:album", m.Album)
	}

	// Twitter card — Discord reads these too as a fallback.
	writeMetaProp(&b, "twitter:card", "player")
	writeMetaProp(&b, "twitter:title", m.Title)
	writeMetaProp(&b, "twitter:description", m.Description)
	writeMetaProp(&b, "twitter:player:stream", m.VideoURL)
	writeMetaProp(&b, "twitter:player:stream:content_type", "video/mp4")
	writeMetaProp(&b, "twitter:player:width", "720")
	writeMetaProp(&b, "twitter:player:height", "720")
	writeMetaProp(&b, "twitter:image", "0")

	b.WriteString("\n</head>\n<body>")
	b.WriteString(`<p>Opening <a href="` + html.EscapeString(m.Landing) + `">Lumen</a>&hellip;</p>`)
	if m.Landing != "" {
		landingJSON, _ := json.Marshal(m.Landing)
		b.WriteString(`<script>if(typeof navigator!=="undefined"){location.replace(` + string(landingJSON) + `)}</script>`)
	}
	b.WriteString("</body>\n</html>\n")
	return b.String()
}

func renderShareEmbedPage(m shareMeta) string {
	var b strings.Builder
	b.Grow(4096)
	b.WriteString("<!doctype html>\n<html lang=\"en\">\n<head>\n")
	b.WriteString(`<meta charset="utf-8">`)
	b.WriteString(`<meta name="viewport" content="width=device-width,initial-scale=1">`)
	writeTitleTag(&b, m.Title, m.Artist)
	writeMetaName(&b, "description", m.Description)
	writeMetaName(&b, "robots", "noindex")
	writeMetaName(&b, "theme-color", m.ThemeColor)
	b.WriteString(`<style>html,body{margin:0;width:100%;height:100%;background:#050505;color:#fff;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{display:grid;place-items:center}.player{position:relative;width:100%;height:100%;min-height:240px;background:#050505}video{display:block;width:100%;height:100%;object-fit:cover;background:#050505}.fallback{position:absolute;left:16px;right:16px;bottom:16px;text-align:center}.fallback a{color:#fff}</style>`)
	b.WriteString("\n</head>\n<body>")
	b.WriteString(`<div class="player">`)
	b.WriteString(`<video controls playsinline preload="metadata"`)
	if m.CoverURL != "" {
		b.WriteString(` poster="` + html.EscapeString(m.CoverURL) + `"`)
	}
	b.WriteString(` src="` + html.EscapeString(m.VideoURL) + `">`)
	b.WriteString(`</video>`)
	if m.Landing != "" {
		b.WriteString(`<p class="fallback"><a href="` + html.EscapeString(m.Landing) + `">Open in Lumen</a></p>`)
	}
	b.WriteString(`</div>`)
	b.WriteString("</body>\n</html>\n")
	return b.String()
}

func writeTitleTag(b *strings.Builder, title, artist string) {
	full := title
	if artist != "" {
		full = title + " — " + artist
	}
	b.WriteString("<title>")
	b.WriteString(html.EscapeString(full))
	b.WriteString("</title>")
}

func writeMetaProp(b *strings.Builder, property, content string) {
	if content == "" {
		return
	}
	b.WriteString(`<meta property="`)
	b.WriteString(html.EscapeString(property))
	b.WriteString(`" content="`)
	b.WriteString(html.EscapeString(content))
	b.WriteString(`">`)
}

func writeMetaName(b *strings.Builder, name, content string) {
	if content == "" {
		return
	}
	b.WriteString(`<meta name="`)
	b.WriteString(html.EscapeString(name))
	b.WriteString(`" content="`)
	b.WriteString(html.EscapeString(content))
	b.WriteString(`">`)
}
