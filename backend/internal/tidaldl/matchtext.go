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

// artistKey is an artist name in comparable form ("&" reads "and"), less a
// leading "The": "The Beatles" and "Beatles" are one act, while every other
// word counts ("And One" isn't "One").
func artistKey(s string) string {
	w := words(s)
	if rest, ok := strings.CutPrefix(w, "the "); ok {
		return rest
	}
	return w
}

// connectors join the credits ingest splits a combined artist tag at.
var connectors = map[string]bool{
	"and": true, "x": true, "vs": true, "with": true, "feat": true, "ft": true, "featuring": true,
}

// withoutConnectors drops connector words, for comparing a combined credit
// with the names ingest split it into.
func withoutConnectors(key string) string {
	var out []string
	for _, w := range strings.Fields(key) {
		if !connectors[w] {
			out = append(out, w)
		}
	}
	return strings.Join(out, " ")
}

// artistsOverlap reports whether two artist lists share a credit. Ingest
// splits "Simon & Garfunkel" into "Simon" and "Garfunkel", so a credit on
// one side may be several consecutive names on the other; a name only part
// of a credit ("Future" in "Future Islands") doesn't count.
func artistsOverlap(local, remote []string) bool {
	l, r := artistKeys(local), artistKeys(remote)
	return len(l) > 0 && len(r) > 0 && (sharesCredit(l, r) || sharesCredit(r, l))
}

// artistKeys is each name in artistKey form, blanks dropped.
func artistKeys(names []string) []string {
	var out []string
	for _, n := range names {
		if k := artistKey(n); k != "" {
			out = append(out, k)
		}
	}
	return out
}

// sharesCredit reports whether a name in split equals one in whole, or
// several consecutive names in split equal one in whole less the
// connectors that joined them.
func sharesCredit(split, whole []string) bool {
	credits, combined := map[string]bool{}, map[string]bool{}
	for _, w := range whole {
		credits[w] = true
		combined[withoutConnectors(w)] = true
	}
	for i := range split {
		if credits[split[i]] {
			return true
		}
		for j := i + 2; j <= len(split); j++ {
			if combined[strings.Join(split[i:j], " ")] {
				return true
			}
		}
	}
	return false
}

func isVariousArtists(s string) bool {
	return strings.EqualFold(strings.TrimSpace(s), "Various Artists")
}

// isCompilation reports whether a release's album artist makes it a
// compilation, as library albums are filed: none, or Various Artists.
func isCompilation(albumArtist string) bool {
	return strings.TrimSpace(albumArtist) == "" || isVariousArtists(albumArtist)
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
