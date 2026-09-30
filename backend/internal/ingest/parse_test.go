package ingest

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

// The tag library falls back to ARTIST for a Vorbis file's composer, never
// the other way round: a COMPOSER-only file has no performers, so dedup
// can't rank it as naming the track's artists.
func TestComposerOnlyVorbisTagHasNoPerformer(t *testing.T) {
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
	comments := []string{"TITLE=Produced", "COMPOSER=Producer"}
	vc := le(append(le(nil, 4), "test"...), uint32(len(comments)))
	for _, c := range comments {
		vc = append(le(vc, uint32(len(c))), c...)
	}
	data = append(append(data, block(4, true, vc)...), "audio"...)
	path := filepath.Join(t.TempDir(), "produced.flac")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	md, err := ParseFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(md.Artists) != 0 || md.Composer != "Producer" {
		t.Fatalf("artists = %+v, composer = %q", md.Artists, md.Composer)
	}
}
