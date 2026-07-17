package dbtext

import (
	"testing"
	"unicode/utf8"
)

func TestCleanStripsNULBytes(t *testing.T) {
	raw := "Hip-Hop\x00\x00"

	if Valid(raw) {
		t.Fatal("NUL bytes must not count as valid")
	}
	if got := Clean(raw); got != "Hip-Hop" {
		t.Fatalf("unexpected cleaned string: %q", got)
	}

	mixed := "H" + string([]byte{0xfd}) + "y\x00.mp3"
	if got := Clean(mixed); got != "H�y.mp3" {
		t.Fatalf("unexpected cleaned string: %q", got)
	}
}

func TestCleanReplacesInvalidUTF8(t *testing.T) {
	raw := "H" + string([]byte{0xfd}) + "y.mp3"

	if Valid(raw) {
		t.Fatal("test string should be invalid UTF-8")
	}
	got := Clean(raw)
	if !utf8.ValidString(got) {
		t.Fatalf("cleaned string is still invalid: %q", got)
	}
	if got != "H\uFFFDy.mp3" {
		t.Fatalf("unexpected cleaned string: %q", got)
	}
}
