package dbtext

import (
	"strings"
	"unicode/utf8"
)

const replacement = "\uFFFD"

// Valid reports whether s can be stored in a PostgreSQL text column as-is:
// valid UTF-8 with no NUL bytes. NUL is valid UTF-8 but PostgreSQL rejects
// it in text values (SQLSTATE 22021).
func Valid(s string) bool {
	return utf8.ValidString(s) && !strings.ContainsRune(s, 0)
}

// Clean returns a string safe for PostgreSQL text parameters: invalid UTF-8
// is replaced with U+FFFD and NUL bytes are dropped.
func Clean(s string) string {
	if Valid(s) {
		return s
	}
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, replacement)
	}
	return strings.ReplaceAll(s, "\x00", "")
}
