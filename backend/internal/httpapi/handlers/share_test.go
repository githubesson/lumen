package handlers

import (
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"
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
