package tag

// Regression tests for Lumen's hardening of the fork: crafted files must come
// back as errors, quickly and without large allocations, never as panics.

import (
	"bytes"
	"testing"
)

// A file of nothing but nested moov headers (the 52 MB crasher, cut down)
// stops at the depth limit instead of recursing until the stack overflows,
// and reads nothing past it.
func TestReadAtomsNestingLimit(t *testing.T) {
	ftyp := atom("ftyp", []byte("M4A "), make([]byte, 4))
	moov := []byte{0, 0, 0, 8, 'm', 'o', 'o', 'v'}

	ok := append(append([]byte(nil), ftyp...), bytes.Repeat(moov, maxAtomDepth)...)
	if _, err := ReadFrom(bytes.NewReader(ok)); err != nil {
		t.Fatalf("%d nested atoms: %v", maxAtomDepth, err)
	}

	deep := append(append([]byte(nil), ftyp...), bytes.Repeat(moov, 1<<20)...)
	r := bytes.NewReader(deep)
	if _, err := ReadFrom(r); err == nil {
		t.Fatal("a million nested atoms parsed without error")
	}
	if read, limit := r.Size()-int64(r.Len()), len(ftyp)+len(moov)*(maxAtomDepth+1); read > int64(limit) {
		t.Fatalf("read %d bytes, want the parser to stop within %d", read, limit)
	}
}

// readAll calls every accessor, as Lumen's ingest does.
func readAll(m Metadata) (testMetadata, *Picture) {
	var tm testMetadata
	tm.Album, tm.AlbumArtist, tm.Artist = m.Album(), m.AlbumArtist(), m.Artist()
	tm.Comment, tm.Composer, tm.Genre = m.Comment(), m.Composer(), m.Genre()
	tm.Lyrics, tm.Title, tm.Year = m.Lyrics(), m.Title(), m.Year()
	tm.Disc, tm.DiscTotal = m.Disc()
	tm.Track, tm.TrackTotal = m.Track()
	m.Format()
	m.FileType()
	m.Raw()
	return tm, m.Picture()
}

// The file picks each MP4 value's type: a data atom's class, or a custom ----
// atom named after a standard one. A value of the wrong type reads as absent;
// it used to panic an unchecked type assertion in the accessor.
func TestMP4AccessorsIgnoreWrongTypes(t *testing.T) {
	custom := func(name, value string) []byte {
		return atom("----",
			atom("mean", make([]byte, 4), []byte("com.apple.iTunes")),
			atom("name", make([]byte, 4), []byte(name)),
			atom("data", []byte{0, 0, 0, 1}, make([]byte, 4), []byte(value)))
	}
	ilst := atom("ilst",
		ilstItem("\xa9nam", 21, []byte{7}),     // class 21 stores an int
		ilstItem("\xa9ART", 13, samplePicture), // class 13 stores a *Picture
		ilstItem("\xa9day", 21, []byte{7}),
		ilstItem("\xa9lyr", 14, samplePicture),
		ilstItem("\xa9cmt", 21, []byte{7}),
		custom("trkn_count", "six"),
		custom("disk_count", "two"),
		custom("covr", "not a picture"),
	)
	file := append(atom("ftyp", []byte("M4A "), make([]byte, 4)),
		atom("moov", atom("udta", atom("meta", make([]byte, 4), ilst)))...)
	m, err := ReadFrom(bytes.NewReader(file))
	if err != nil {
		t.Fatal(err)
	}
	if got, p := readAll(m); got != emptyMetadata || p != nil {
		t.Fatalf("got %+v, picture %v; want every field empty", got, p)
	}
}

// The ID3 readers store each frame with the type its accessor expects, but
// the accessors no longer rely on that.
func TestID3AccessorsIgnoreWrongTypes(t *testing.T) {
	for _, m := range []Metadata{
		metadataID3v2{header: &id3v2Header{Version: ID3v2_3}, frames: map[string]interface{}{
			"TIT2": 1, "TPE1": []byte("x"), "TYER": 2000, "TRCK": 3, "TCON": &Comm{},
			"COMM": "comment", "USLT": 1, "APIC": "picture",
		}},
		metadataID3v1{"title": 1, "artist": []byte("x"), "year": 2000, "track": "3", "comment": nil},
	} {
		if got, p := readAll(m); got != emptyMetadata || p != nil {
			t.Errorf("%T: got %+v, picture %v; want every field empty", m, got, p)
		}
	}
}
