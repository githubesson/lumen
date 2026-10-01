package tidaldl

import (
	"regexp"
	"strings"
	"unicode"

	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"

	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/tidal"
)

// How library tracks are compared with TIDAL's. Titles compare without
// featured-artist credits and qualifiers that name another master or edition
// of the same recording ("2011 Remaster", "Explicit"); qualifiers that name
// another recording ("Live", "Acoustic", a remix) still count. Album titles
// also drop edition qualifiers ("Deluxe Edition", " - Single"), so a release
// is found under any of its editions, and the best edition is picked by
// which tracks it lists.

var (
	// "(feat. X)", "[ft. X]", "(with X)".
	featGroupRe = regexp.MustCompile(`(?i)[(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]`)
	// " feat. X" to the end.
	featTailRe = regexp.MustCompile(`(?i)\s(?:feat\.?|ft\.?|featuring)\s.*$`)
	groupRe    = regexp.MustCompile(`[(\[]([^)\]]*)[)\]]`)
	dashTailRe = regexp.MustCompile(`\s[-–—]\s([^-–—]+)$`)

	remasterNoise = `(?:\d{4}\s+)?(?:digital(?:ly)?\s+)?re-?master(?:ed)?(?:\s+\d{4})?(?:\s+(?:version|edition))?`
	titleNoiseRe  = regexp.MustCompile(`(?i)^(?:` + remasterNoise +
		`|explicit|clean|album version|lp version|single version|mono|stereo)$`)
	albumNoiseRe = regexp.MustCompile(`(?i)^(?:` + remasterNoise +
		`|explicit|clean|single|ep|(?:super\s+)?deluxe(?:\s+(?:edition|version))?` +
		`|(?:\S+\s+)?(?:anniversary|expanded|special|bonus tracks?|collector'?s|limited|legacy|platinum|standard|international)(?:\s+(?:edition|version))?)$`)

	foldAccents = transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)), norm.NFC)
)

// matchTitle is a track title in comparable form.
func matchTitle(s string) string { return stripQualifiers(s, titleNoiseRe) }

// matchAlbum is an album title in comparable form.
func matchAlbum(s string) string { return stripQualifiers(s, albumNoiseRe) }

func stripQualifiers(s string, noise *regexp.Regexp) string {
	s = featGroupRe.ReplaceAllString(s, " ")
	s = featTailRe.ReplaceAllString(s, "")
	s = groupRe.ReplaceAllStringFunc(s, func(g string) string {
		inner := strings.TrimSpace(g[1 : len(g)-1])
		if noise.MatchString(inner) {
			return " "
		}
		return " " + inner + " "
	})
	for {
		m := dashTailRe.FindStringSubmatchIndex(s)
		if m == nil || !noise.MatchString(strings.TrimSpace(s[m[2]:m[3]])) {
			break
		}
		s = s[:m[0]]
	}
	return words(s)
}

// words lower-cases s, drops accents and punctuation, and collapses spaces.
func words(s string) string {
	if folded, _, err := transform.String(foldAccents, s); err == nil {
		s = folded
	}
	s = strings.ReplaceAll(strings.ToLower(s), "&", " and ")
	return strings.Join(strings.FieldsFunc(s, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	}), " ")
}

// artistWords is an artist name in comparable form: "and" and "the" don't
// count, so "Simon & Garfunkel" and "Simon and Garfunkel" compare equal.
func artistWords(s string) []string {
	var out []string
	for _, w := range strings.Fields(words(s)) {
		if w != "and" && w != "the" {
			out = append(out, w)
		}
	}
	return out
}

// artistsOverlap reports whether two artist lists share a credit. Ingest
// splits "Simon & Garfunkel" into "Simon" and "Garfunkel", so a credit on
// one side may be several consecutive names on the other; a name only part
// of a credit ("Future" in "Future Islands") doesn't count.
func artistsOverlap(local, remote []string) bool {
	l, r := artistKeys(local), artistKeys(remote)
	return len(l) > 0 && len(r) > 0 && (sharesCredit(l, r) || sharesCredit(r, l))
}

// artistKeys is each name in artistWords form, joined, blanks dropped.
func artistKeys(names []string) []string {
	var out []string
	for _, n := range names {
		if w := artistWords(n); len(w) > 0 {
			out = append(out, strings.Join(w, " "))
		}
	}
	return out
}

// sharesCredit reports whether consecutive names in split, joined, equal a
// name in whole.
func sharesCredit(split, whole []string) bool {
	credits := map[string]bool{}
	for _, w := range whole {
		credits[w] = true
	}
	for i := range split {
		for j := i + 1; j <= len(split); j++ {
			if credits[strings.Join(split[i:j], " ")] {
				return true
			}
		}
	}
	return false
}

func isVariousArtists(s string) bool {
	return strings.EqualFold(strings.TrimSpace(s), "Various Artists")
}

const (
	// TIDAL lists durations in whole seconds, and files differ by padding.
	durationSlackMS = 3000
	// Same ISRC: the same recording, so only a gross mismatch (a wrong tag)
	// disqualifies.
	isrcDurationSlackMS = 10000
)

// trackMatches reports whether a TIDAL track is the library track's
// recording: the same ISRC, or the same title, artist and duration. relaxed
// is for a release the track's album is already linked to: there a track
// without artists or a known duration may still match on its title.
func trackMatches(t MatchTrack, c tidal.Track, relaxed bool) bool {
	return titledMatch(t, c, matchTitle(t.Title), matchTitle(c.Title), relaxed)
}

// titledMatch is trackMatches with both titles already in matchTitle form.
func titledMatch(t MatchTrack, c tidal.Track, title, cTitle string, relaxed bool) bool {
	known := t.DurationMS > 0 && c.DurationMS > 0
	diff := abs(t.DurationMS - c.DurationMS)
	if sameISRC(t.ISRC, c.ISRC) {
		return !known || diff <= isrcDurationSlackMS
	}
	if title == "" || title != cTitle {
		return false
	}
	if known {
		if diff > durationSlackMS {
			return false
		}
	} else if !relaxed {
		return false
	}
	if len(t.Artists) == 0 {
		return relaxed
	}
	return artistsOverlap(t.Artists, c.Artists)
}

// sameISRC reports whether two ISRCs are the same code, however written.
func sameISRC(a, b string) bool {
	a = ingest.NormalizeISRC(a)
	return a != "" && a == ingest.NormalizeISRC(b)
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
