package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/library"
)

func TestRenderSharePageIncludesVideoAndPlayerMetadata(t *testing.T) {
	html := renderSharePage(shareMeta{
		Title:       `Track "One"`,
		Description: "Artist - Album",
		Artist:      "Artist",
		Album:       "Album",
		Canonical:   "https://lumen.test/share/track/abc?t=12&sig=share",
		CoverURL:    "https://lumen.test/api/public/covers/album/cover?exp=1&sig=cover",
		VideoURL:    "https://lumen.test/api/public/preview-videos/abc.mp4?t=12&sig=share",
		Landing:     "https://lumen.test/shared/track/abc?t=12&sig=share",
	})

	want := []string{
		`<meta property="og:video" content="https://lumen.test/api/public/preview-videos/abc.mp4?t=12&amp;sig=share">`,
		`<meta property="og:video:type" content="video/mp4">`,
		`<meta property="og:video:duration" content="30">`,
		`<meta property="twitter:player:stream" content="https://lumen.test/api/public/preview-videos/abc.mp4?t=12&amp;sig=share">`,
		`<meta property="twitter:player:stream:content_type" content="video/mp4">`,
		`<meta property="twitter:image" content="0">`,
		`Track &#34;One&#34;`,
	}
	for _, part := range want {
		if !strings.Contains(html, part) {
			t.Fatalf("rendered share page missing %q in:\n%s", part, html)
		}
	}
	if strings.Contains(html, `property="twitter:player" content=`) {
		t.Fatalf("share page should advertise a direct stream, not an iframe player:\n%s", html)
	}
	if strings.Contains(html, `http-equiv="refresh"`) {
		t.Fatalf("share page should not meta-refresh scrapers away from OG tags:\n%s", html)
	}
	if !strings.Contains(html, `if(typeof navigator!=="undefined"){location.replace("https://lumen.test/shared/track/abc?t=12\u0026sig=share")}`) {
		t.Fatalf("share page should still redirect humans with script fallback:\n%s", html)
	}
}

func TestRenderSharePageUsesSelectedDuration(t *testing.T) {
	html := renderSharePage(shareMeta{
		Title:       "Long clip",
		VideoURL:    "https://lumen.test/preview.mp4",
		DurationSec: 75,
	})
	if !strings.Contains(html, `<meta property="og:video:duration" content="75">`) {
		t.Fatalf("rendered share page does not advertise selected duration:\n%s", html)
	}
}

func TestRequestedPreviewDuration(t *testing.T) {
	tests := []struct {
		name      string
		raw       string
		trackMS   int
		want      int
		wantField bool
		wantErr   bool
	}{
		{name: "legacy default", raw: "", trackMS: 180_000, want: 30, wantField: false},
		{name: "selected", raw: "75", trackMS: 180_000, want: 75, wantField: true},
		{name: "song cap", raw: "120", trackMS: 62_400, want: 63, wantField: true},
		{name: "short song", raw: "5", trackMS: 3_200, want: 4, wantField: true},
		{name: "below minimum", raw: "4", trackMS: 180_000, wantErr: true},
		{name: "above maximum", raw: "121", trackMS: 180_000, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, gotField, err := requestedPreviewDuration(tt.raw, tt.trackMS)
			if (err != nil) != tt.wantErr {
				t.Fatalf("error = %v, wantErr %v", err, tt.wantErr)
			}
			if err == nil && (got != tt.want || gotField != tt.wantField) {
				t.Fatalf("duration = (%d, %v), want (%d, %v)", got, gotField, tt.want, tt.wantField)
			}
		})
	}
}

func TestMaximumPreviewStartUsesMillisecondDuration(t *testing.T) {
	if got := maximumPreviewStartSec(125_700, 120); got != 5 {
		t.Fatalf("max start = %d, want 5", got)
	}
	if got := maximumPreviewStartSec(30_200, 30); got != 0 {
		t.Fatalf("max start = %d, want 0", got)
	}
}

func TestShareURLsIncludeDurationOnlyForNewLinks(t *testing.T) {
	id := uuid.MustParse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
	newURL, err := url.Parse(sharePageURL("https://lumen.test", id, 12, 75, "signed"))
	if err != nil {
		t.Fatal(err)
	}
	if got := newURL.Query().Get("d"); got != "75" {
		t.Fatalf("new link duration = %q, want 75", got)
	}
	legacyURL, err := url.Parse(sharePageURL("https://lumen.test", id, 12, 0, "signed"))
	if err != nil {
		t.Fatal(err)
	}
	if legacyURL.Query().Has("d") {
		t.Fatalf("legacy link unexpectedly has duration: %s", legacyURL)
	}
}

func TestRenderShareEmbedPageIncludesEscapedVideoPlayer(t *testing.T) {
	html := renderShareEmbedPage(shareMeta{
		Title:       `Track "One"`,
		Description: "Artist - Album",
		Artist:      "Artist",
		CoverURL:    "https://lumen.test/cover.jpg?x=1&y=2",
		VideoURL:    "https://lumen.test/preview.mp4?t=12&sig=video",
		Landing:     "https://lumen.test/shared/track/abc?t=12&sig=share",
		ThemeColor:  "#123456",
	})

	want := []string{
		`<meta name="robots" content="noindex">`,
		`poster="https://lumen.test/cover.jpg?x=1&amp;y=2"`,
		`src="https://lumen.test/preview.mp4?t=12&amp;sig=video"`,
		`<a href="https://lumen.test/shared/track/abc?t=12&amp;sig=share">Open in Lumen</a>`,
	}
	for _, part := range want {
		if !strings.Contains(html, part) {
			t.Fatalf("rendered embed page missing %q in:\n%s", part, html)
		}
	}
}

func TestSignedPreviewAudioURLUsesM4APath(t *testing.T) {
	id := uuid.MustParse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
	u, err := url.Parse(signedPreviewAudioURL("https://lumen.test", id, 12, 75, 99, "signed"))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := u.Path, "/api/public/preview-audio/"+id.String()+".m4a"; got != want {
		t.Fatalf("path = %q, want %q", got, want)
	}
	q := u.Query()
	if q.Get("t") != "12" || q.Get("d") != "75" || q.Get("exp") != "99" || q.Get("sig") != "signed" {
		t.Fatalf("unexpected query: %s", u.RawQuery)
	}
}

func TestRenderSharePageIncludesDiscordComponentEmbed(t *testing.T) {
	landing := "https://lumen.test/shared/track/abc?t=12&d=30&sig=share"
	video := "https://lumen.test/api/public/preview-videos/abc.mp4?t=12&d=30&sig=share"
	audio := "https://lumen.test/api/public/preview-audio/abc.m4a?t=12&d=30&sig=share"
	icon := "https://lumen.test/api/public/brand/lumen-icon.png"
	html := renderSharePage(shareMeta{
		Title:            `Song [Live] </script>`,
		Artist:           "*NSYNC",
		Album:            "No_Strings",
		Canonical:        "https://lumen.test/share/track/abc?t=12&d=30&sig=share",
		CoverURL:         "https://lumen.test/api/public/covers/album/cover?exp=1&sig=cover",
		IconURL:          icon,
		VideoURL:         video,
		Landing:          landing,
		ThemeColor:       "#1abc9c",
		DurationSec:      30,
		VideoDownloadURL: video + "&download=1",
		AudioDownloadURL: audio + "&download=1",
	})

	start := strings.Index(html, `<script id="discord:component-embed" type="application/json">`)
	if start < 0 {
		t.Fatalf("share page missing component embed script:\n%s", html)
	}
	headEnd := strings.Index(html, "</head>")
	if start > headEnd {
		t.Fatalf("component embed must sit inside <head>:\n%s", html)
	}
	rest := html[start+len(`<script id="discord:component-embed" type="application/json">`):]
	end := strings.Index(rest, "</script>")
	raw := rest[:end]
	if len(raw) > discordComponentEmbedMaxBytes {
		t.Fatalf("payload is %d bytes, over Discord's %d cap", len(raw), discordComponentEmbedMaxBytes)
	}

	var embed discordComponentEmbed
	if err := json.Unmarshal([]byte(raw), &embed); err != nil {
		t.Fatalf("payload is not JSON: %v\n%s", err, raw)
	}
	c := embed.Component
	if c.Type != discordComponentContainer {
		t.Fatalf("top-level type = %d, want container (17)", c.Type)
	}
	if c.AccentColor == nil || *c.AccentColor != 0x1abc9c {
		t.Fatalf("accent color = %v, want %d", c.AccentColor, 0x1abc9c)
	}
	if len(c.Components) != 4 {
		t.Fatalf("container has %d children, want section, gallery, separator, buttons:\n%s", len(c.Components), raw)
	}
	section := c.Components[0]
	if section.Type != discordComponentSection || section.Accessory == nil || section.Accessory.Type != discordComponentThumbnail {
		t.Fatalf("first child should be a section with a thumbnail accessory: %+v", section)
	}
	// The thumbnail is the app icon, not the album cover.
	if section.Accessory.Media == nil || section.Accessory.Media.URL != icon {
		t.Fatalf("thumbnail should be the Lumen icon %q, got %+v", icon, section.Accessory.Media)
	}
	text := section.Components[0].Content
	// The script element must not be closable from inside the JSON, and the
	// title text must render literally: Discord shows a backslash before a
	// bracket as-is, so brackets stay unescaped inside the link label.
	if strings.Contains(raw, "</script>") {
		t.Fatalf("payload contains an unescaped </script>: %s", raw)
	}
	wantText := "## [Song [Live] </script>](" + landing + ")\n-# \\*NSYNC · No\\_Strings"
	if text != wantText {
		t.Fatalf("heading text = %q, want %q", text, wantText)
	}
	gallery := c.Components[1]
	if gallery.Type != discordComponentMediaGallery || len(gallery.Items) != 1 || gallery.Items[0].Media.URL != video {
		t.Fatalf("second child should be a gallery with the preview video: %+v", gallery)
	}
	if gallery.Items[0].Description != "30-second preview clip" {
		t.Fatalf("gallery description = %q", gallery.Items[0].Description)
	}
	row := c.Components[3]
	if row.Type != discordComponentActionRow {
		t.Fatalf("last child should be an action row: %+v", row)
	}
	var labels []string
	for _, b := range row.Components {
		if b.Type != discordComponentButton || b.Style != discordButtonStyleLink {
			t.Fatalf("link previews only accept link-style buttons: %+v", b)
		}
		labels = append(labels, b.Label+"="+b.URL)
	}
	wantLabels := []string{
		"Open in Lumen=" + landing,
		"Download video=" + video + "&download=1",
		"Download audio=" + audio + "&download=1",
	}
	if strings.Join(labels, "\n") != strings.Join(wantLabels, "\n") {
		t.Fatalf("buttons = %q, want %q", labels, wantLabels)
	}
	// Open Graph stays as the fallback.
	if !strings.Contains(html, `<meta property="og:video" content=`) {
		t.Fatalf("component embed must not replace the og:video fallback")
	}
}

func TestDiscordHeadingFallsBackToPlainTextOnUnbalancedBrackets(t *testing.T) {
	landing := "https://lumen.test/shared/track/abc?t=0&sig=s"
	cases := map[string]string{
		"Plain":          "## [Plain](" + landing + ")",
		"Song [Live]":    "## [Song [Live]](" + landing + ")",
		"a [b [c]] d":    "## a [b [c]] d",
		"Broken ] title": "## Broken ] title",
		"Open [ title":   "## Open [ title",
		"*Star* [x]":     "## [\\*Star\\* [x]](" + landing + ")",
	}
	for title, want := range cases {
		if got := discordHeading(title, landing); got != want {
			t.Errorf("discordHeading(%q) = %q, want %q", title, got, want)
		}
	}
}

func TestPublicLumenIconServesEmbeddedPNG(t *testing.T) {
	h := &Share{}
	rec := httptest.NewRecorder()
	h.PublicLumenIcon(rec, httptest.NewRequest(http.MethodGet, lumenIconPath, nil))
	res := rec.Result()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != "image/png" {
		t.Fatalf("content-type = %q", ct)
	}
	body := rec.Body.Bytes()
	if !bytes.HasPrefix(body, []byte("\x89PNG\r\n\x1a\n")) {
		t.Fatalf("body is not a PNG (%d bytes)", len(body))
	}
	if etag := res.Header.Get("ETag"); etag == "" {
		t.Fatal("expected an ETag")
	}

	// Conditional requests short-circuit on the ETag.
	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, lumenIconPath, nil)
	req.Header.Set("If-None-Match", lumenIconETag)
	h.PublicLumenIcon(rec, req)
	if rec.Code != http.StatusNotModified {
		t.Fatalf("status with matching ETag = %d, want 304", rec.Code)
	}
}

func TestDiscordComponentEmbedWithoutIconUsesOpenAccessory(t *testing.T) {
	payload, ok := buildDiscordComponentEmbed(shareMeta{
		Title:    "Untagged",
		VideoURL: "https://lumen.test/v.mp4?t=0&sig=s",
		Landing:  "https://lumen.test/shared/track/abc?t=0&sig=s",
	})
	if !ok {
		t.Fatal("expected a payload")
	}
	var embed discordComponentEmbed
	if err := json.Unmarshal(payload, &embed); err != nil {
		t.Fatal(err)
	}
	section := embed.Component.Components[0]
	if section.Accessory == nil || section.Accessory.Type != discordComponentButton || section.Accessory.Label != "Open" {
		t.Fatalf("a section without an icon needs the Open button as its accessory: %+v", section.Accessory)
	}
	if embed.Component.AccentColor != nil {
		t.Fatalf("no theme color should mean no accent_color, got %d", *embed.Component.AccentColor)
	}
	if len(embed.Component.Components) != 2 {
		t.Fatalf("with no download URLs the card should be section + gallery only, got %d children", len(embed.Component.Components))
	}
}

func TestDiscordComponentEmbedShrinksToFitTheCap(t *testing.T) {
	long := strings.Repeat("Very long title ", 200)
	base := shareMeta{
		Title:            long,
		Artist:           long,
		Album:            long,
		IconURL:          "https://lumen.test/api/public/brand/lumen-icon.png",
		VideoURL:         "https://lumen.test/v.mp4?t=0&sig=s",
		Landing:          "https://lumen.test/shared/track/abc?t=0&sig=s",
		VideoDownloadURL: "https://lumen.test/v.mp4?t=0&sig=s&download=1",
		AudioDownloadURL: "https://lumen.test/a.m4a?t=0&sig=s&download=1",
	}
	payload, ok := buildDiscordComponentEmbed(base)
	if !ok {
		t.Fatal("a long title should shrink, not drop the embed")
	}
	if len(payload) > discordComponentEmbedMaxBytes {
		t.Fatalf("payload is %d bytes, over the cap", len(payload))
	}
	var embed discordComponentEmbed
	if err := json.Unmarshal(payload, &embed); err != nil {
		t.Fatal(err)
	}
	text := embed.Component.Components[0].Components[0].Content
	if !strings.Contains(text, "…") {
		t.Fatalf("shrunk heading should be truncated with an ellipsis: %q", text)
	}

	// URLs can't be shortened; when even the smallest variant is over the
	// cap, the page falls back to Open Graph instead of emitting an invalid
	// payload.
	huge := base
	huge.VideoURL = "https://lumen.test/v.mp4?pad=" + strings.Repeat("x", 3000)
	if _, ok := buildDiscordComponentEmbed(huge); ok {
		t.Fatal("an oversized payload must be omitted")
	}
	if strings.Contains(renderSharePage(huge), "discord:component-embed") {
		t.Fatal("share page should omit the script tag when no variant fits")
	}
}

func TestEscapeDiscordMarkdown(t *testing.T) {
	got := escapeDiscordMarkdown("a*b_c~d`e|f>g#h[i]j<k\\l\nm")
	want := `a\*b\_c\~d\` + "`" + `e\|f>g#h[i]j<k\\l m`
	if got != want {
		t.Fatalf("escape = %q, want %q", got, want)
	}
}

func TestSharePreviewAudioURLIsShareSigned(t *testing.T) {
	id := uuid.MustParse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
	u, err := url.Parse(downloadURL(sharePreviewAudioURL("https://lumen.test", id, 12, 75, "signed")))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := u.Path, "/api/public/preview-audio/"+id.String()+".m4a"; got != want {
		t.Fatalf("path = %q, want %q", got, want)
	}
	q := u.Query()
	if q.Get("t") != "12" || q.Get("d") != "75" || q.Get("sig") != "signed" || q.Get("download") != "1" {
		t.Fatalf("unexpected query: %s", u.RawQuery)
	}
	if q.Has("exp") {
		t.Fatalf("share-signed audio URL must not expire: %s", u.RawQuery)
	}
}

func TestClipFilenameAndAttachmentDisposition(t *testing.T) {
	name := clipFilename(&library.TrackDetail{
		Title:   `Song: "Live" / Remix?`,
		Artists: []library.TrackArtist{{Name: "Artist", Role: "primary"}},
	})
	if name != `Artist - Song_ _Live_ _ Remix_ (clip)` {
		t.Fatalf("clip name = %q", name)
	}
	if got := clipFilename(nil); got != "Lumen (clip)" {
		t.Fatalf("fallback clip name = %q", got)
	}

	if got, want := attachmentDisposition("Artist - Song (clip).mp4"), `attachment; filename="Artist - Song (clip).mp4"`; got != want {
		t.Fatalf("ascii disposition = %q, want %q", got, want)
	}
	got := attachmentDisposition("Björk - Jóga (clip).m4a")
	want := `attachment; filename="Bj_rk - J_ga (clip).m4a"; filename*=UTF-8''Bj%C3%B6rk%20-%20J%C3%B3ga%20%28clip%29.m4a`
	if got != want {
		t.Fatalf("utf-8 disposition = %q, want %q", got, want)
	}
}
