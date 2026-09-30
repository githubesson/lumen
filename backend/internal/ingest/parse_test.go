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
