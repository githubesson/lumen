package ingest

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

func writeVorbisFLAC(t *testing.T, comments ...string) string {
	t.Helper()
	block := func(typ byte, last bool, body []byte) []byte {
		h := []byte{typ, byte(len(body) >> 16), byte(len(body) >> 8), byte(len(body))}
		if last {
			h[0] |= 0x80
		}
		return append(h, body...)
	}
	le := binary.LittleEndian.AppendUint32
	streaminfo := make([]byte, 34)
	binary.BigEndian.PutUint64(streaminfo[10:18], uint64(44100)<<44|uint64(1)<<41|uint64(15)<<36|88200)
	data := append([]byte("fLaC"), block(0, false, streaminfo)...)
	vc := le(append(le(nil, 4), "test"...), uint32(len(comments)))
	for _, c := range comments {
		vc = append(le(vc, uint32(len(c))), c...)
	}
	data = append(append(data, block(4, true, vc)...), "audio"...)
	path := filepath.Join(t.TempDir(), "tagged.flac")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

// A Vorbis file's composer is its COMPOSER comment alone: not the tag
// library's PERFORMER/ARTIST fallback, and a COMPOSER-only file names no
// performer.
func TestVorbisComposerTag(t *testing.T) {
	for _, tc := range []struct {
		name         string
		comments     []string
		wantArtists  int
		wantComposer string
	}{
		{"composer only", []string{"TITLE=Produced", "COMPOSER=Producer"}, 0, "Producer"},
		{"artist only", []string{"TITLE=Sung", "ARTIST=Singer", "PERFORMER=Band"}, 1, ""},
		{"artist who composed", []string{"TITLE=Own", "ARTIST=Singer", "COMPOSER=Singer"}, 1, "Singer"},
	} {
		md, err := ParseFile(writeVorbisFLAC(t, tc.comments...))
		if err != nil {
			t.Fatal(err)
		}
		if len(md.Artists) != tc.wantArtists || md.Composer != tc.wantComposer {
			t.Errorf("%s: artists = %+v, composer = %q", tc.name, md.Artists, md.Composer)
		}
	}
}

// ISRCs are read from the tags and stored in their compact form; anything
// that isn't one is dropped.
func TestISRCTag(t *testing.T) {
	for _, tc := range []struct {
		comment, want string
	}{
		{"ISRC=usum71703861", "USUM71703861"},
		{"ISRC=US-UM7-17-03861", "USUM71703861"},
		{"ISRC=not an isrc", ""},
		{"TITLE=No ISRC", ""},
	} {
		md, err := ParseFile(writeVorbisFLAC(t, "TITLE=Song", tc.comment))
		if err != nil {
			t.Fatal(err)
		}
		if md.ISRC != tc.want {
			t.Errorf("%s: ISRC = %q, want %q", tc.comment, md.ISRC, tc.want)
		}
	}
}

func TestNormalizeISRC(t *testing.T) {
	for in, want := range map[string]string{
		"GBAYE0601498":                 "GBAYE0601498",
		" gb-aye-06-01498 ":            "GBAYE0601498",
		"\x00\x00\x00\x00GBAYE0601498": "GBAYE0601498",
		"GBAYE060149":                  "", // too short
		"G1AYE0601498":                 "", // country code must be letters
		"GBAYE06014X8":                 "", // designation must be digits
		"":                             "",
	} {
		if got := NormalizeISRC(in); got != want {
			t.Errorf("NormalizeISRC(%q) = %q, want %q", in, got, want)
		}
	}
}

// An M4A's ISRC sits in iTunes' freeform atom (----, mean
// com.apple.iTunes, name ISRC); the tag library reports it under its
// name, ISRC.
func TestISRCTagM4A(t *testing.T) {
	atom := func(name string, parts ...[]byte) []byte {
		body := []byte{}
		for _, p := range parts {
			body = append(body, p...)
		}
		return append(binary.BigEndian.AppendUint32(nil, uint32(8+len(body))), append([]byte(name), body...)...)
	}
	zero4 := []byte{0, 0, 0, 0}
	freeform := atom("----",
		atom("mean", zero4, []byte("com.apple.iTunes")),
		atom("name", zero4, []byte("ISRC")),
		atom("data", []byte{0, 0, 0, 1}, zero4, []byte("USUM71703861")))
	title := atom("\xa9nam", atom("data", []byte{0, 0, 0, 1}, zero4, []byte("Song")))
	file := append(atom("ftyp", []byte("M4A "), zero4, []byte("M4A mp42isom")),
		atom("moov", atom("udta", atom("meta", zero4, atom("ilst", title, freeform))))...)
	path := filepath.Join(t.TempDir(), "tagged.m4a")
	if err := os.WriteFile(path, file, 0600); err != nil {
		t.Fatal(err)
	}
	md, err := ParseFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if md.Title != "Song" || md.ISRC != "USUM71703861" {
		t.Fatalf("title %q, ISRC %q; want Song, USUM71703861", md.Title, md.ISRC)
	}
}
