package handlers

import (
	"strings"
	"testing"
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
