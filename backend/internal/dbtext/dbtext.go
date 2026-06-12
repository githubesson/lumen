package dbtext

import (
	"strings"
	"unicode/utf8"
)

const replacement = "\uFFFD"

func Valid(s string) bool {
	return utf8.ValidString(s)
}

// Clean returns a string safe for PostgreSQL text parameters.
func Clean(s string) string {
	if utf8.ValidString(s) {
		return s
	}
	return strings.ToValidUTF8(s, replacement)
}
