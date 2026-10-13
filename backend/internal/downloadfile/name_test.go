package downloadfile

import (
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestSanitizeNameKeepsExtensionWhenCut(t *testing.T) {
	// 3-byte runes: a byte cut at 180 - len(".flac") would split one.
	long := strings.Repeat("音", 100) + ".flac"
	got := SanitizeName(long)
	if !strings.HasSuffix(got, ".flac") {
		t.Fatalf("lost extension: %q", got)
	}
	if !utf8.ValidString(got) {
		t.Fatalf("invalid UTF-8: %q", got)
	}
	if len(got) > maxNameBytes {
		t.Fatalf("len %d exceeds %d", len(got), maxNameBytes)
	}
	if want := strings.Repeat("音", 58) + ".flac"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestSanitizeName(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"  a/b:c?.mp3 ", "a_b_c_.mp3"},
		{"...", "unnamed"},
		{"", "unnamed"},
		{"bad\xffbyte.mp3", "badbyte.mp3"},
		{"short.flac", "short.flac"},
	} {
		if got := SanitizeName(tc.in); got != tc.want {
			t.Errorf("SanitizeName(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	for _, in := range []string{
		strings.Repeat("a", 300),
		strings.Repeat("é", 200),
		// A dotted phrase is no extension; the cut is a plain one.
		"Mr. Brightside " + strings.Repeat("x", 200),
		strings.Repeat("b", 200) + ".flac",
	} {
		got := SanitizeName(in)
		if len(got) > maxNameBytes || !utf8.ValidString(got) {
			t.Errorf("SanitizeName(%d bytes) = %d bytes, valid=%v", len(in), len(got), utf8.ValidString(got))
		}
		if SanitizeName(got) != got {
			t.Errorf("not idempotent: %q", got)
		}
	}
}

func TestPickFilenameFallbackKeepsContentTypeExtension(t *testing.T) {
	resp := &http.Response{Header: http.Header{"Content-Type": {"audio/flac"}}}
	got := PickFilename(resp, "https://files.example/download", strings.Repeat("音", 100))
	if !strings.HasSuffix(got, ".flac") || len(got) > maxNameBytes || !utf8.ValidString(got) {
		t.Fatalf("fallback name = %q (%d bytes)", got, len(got))
	}
}

func TestPickFilenameDecodesExtendedFilename(t *testing.T) {
	resp := &http.Response{Header: http.Header{
		"Content-Disposition": {`attachment; filename*=UTF-8''%E9%9F%B3%20track.flac`},
	}}
	if got := PickFilename(resp, "https://files.example/x", "fallback"); got != "音 track.flac" {
		t.Fatalf("got %q", got)
	}
}
