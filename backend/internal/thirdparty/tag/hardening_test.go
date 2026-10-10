package tag

// Regression tests for Lumen's hardening of the fork: crafted files must come
// back as errors, quickly and without large allocations, never as panics.

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"runtime"
	"strings"
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

// allocated returns how many bytes f allocates.
func allocated(f func()) uint64 {
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	f()
	runtime.ReadMemStats(&after)
	return after.TotalAlloc - before.TotalAlloc
}

func TestReadBytesBounds(t *testing.T) {
	data := make([]byte, 1<<20)
	for _, tc := range []struct {
		name     string
		r        io.Reader
		n        uint
		maxAlloc uint64
	}{
		{"over the cap", bytes.NewReader(data), readBytesMax + 1, 4 << 10},
		{"past the end of a bytes.Reader", bytes.NewReader(data), 2 << 20, 4 << 10},
		{"past the end of a seeker", struct{ io.ReadSeeker }{bytes.NewReader(data)}, 2 << 20, 4 << 10},
		// Nothing tells how much is left, so the read buffers what there is,
		// but no more: not the 50 MiB asked for.
		{"past the end of a plain reader", struct{ io.Reader }{bytes.NewReader(data)}, 50 << 20, 8 << 20},
	} {
		var err error
		if n := allocated(func() { _, err = readBytes(tc.r, tc.n) }); n > tc.maxAlloc {
			t.Errorf("%s: allocated %d bytes, want at most %d", tc.name, n, tc.maxAlloc)
		}
		if err == nil {
			t.Errorf("%s: no error", tc.name)
		}
	}

	// Checking a seeker's length leaves it where it was.
	r := struct{ io.ReadSeeker }{bytes.NewReader([]byte("0123456789"))}
	if _, err := readBytes(r, 3); err != nil {
		t.Fatal(err)
	}
	if left, ok := remaining(r); !ok || left != 7 {
		t.Fatalf("remaining = %d, %v; want 7, true", left, ok)
	}
	if b, err := readBytes(r, 7); err != nil || string(b) != "3456789" {
		t.Fatalf("read %q, %v after the length check; want 3456789", b, err)
	}
}

// Each file here is tiny but claims a field of up to 4 GiB. It must fail
// without that being allocated or read.
func TestLyingSizes(t *testing.T) {
	be32 := binary.BigEndian.AppendUint32
	le32 := binary.LittleEndian.AppendUint32
	flacPictureClaiming := func(n uint32) []byte {
		pic := be32(make([]byte, 28), n) // type, MIME, description, dimensions, then the data length
		return append(append([]byte("fLaC"), flacBlock(6, true, pic)...), "audio"...)
	}
	m4aItem := func(item []byte) []byte {
		file := atom("ftyp", []byte("M4A "), make([]byte, 4))
		file = append(file, 0, 0, 0, 8, 'm', 'o', 'o', 'v', 0, 0, 0, 8, 'i', 'l', 's', 't')
		return append(append(file, item...), make([]byte, 64)...)
	}
	vorbisPacket := func(vendorLen uint32) []byte {
		return oggPages(le32([]byte("\x03vorbis"), vendorLen))
	}
	for _, tc := range []struct {
		name string
		file []byte
	}{
		{"FLAC picture of 4 GiB", flacPictureClaiming(0xffffffff)},
		{"FLAC picture of 50 MiB", flacPictureClaiming(50 << 20)},
		{"FLAC vendor string of 4 GiB", append([]byte("fLaC"), flacBlock(4, true, le32(nil, 0xffffffff))...)},
		{"Ogg vendor string of 4 GiB", vorbisPacket(0xffffffff)},
		{"Ogg vendor string of 50 MiB", vorbisPacket(50 << 20)},
		{"ID3v2.3 frame of 4 GiB", id3v2Tag(3, 0, be32([]byte("TIT2"), 0xffffffff), make([]byte, 64))},
		{"ID3v2.3 extended header of 4 GiB", id3v2Tag(3, 0x40, be32(nil, 0xffffffff), make([]byte, 64))},
		{"MP4 data atom of 4 GiB", m4aItem(append(be32(nil, 0xffffffff), "\xa9nam"...))},
		{"MP4 custom atom of 4 GiB", m4aItem(append(append(be32(nil, 0xfffffff0), "----"...), append(be32(nil, 0xffffff00), "mean"...)...))},
	} {
		var err error
		if n := allocated(func() { _, err = ReadFrom(bytes.NewReader(tc.file)) }); n > 1<<20 {
			t.Errorf("%s: allocated %d bytes", tc.name, n)
		}
		if err == nil {
			t.Errorf("%s: parsed without error", tc.name)
		}
	}

	// A bad METADATA_BLOCK_PICTURE comment is skipped, as upstream does; it
	// just mustn't be allocated either.
	picture := base64.StdEncoding.EncodeToString(be32(make([]byte, 28), 0xffffffff))
	file := oggPages(append([]byte("\x03vorbis"), vorbisComment("TITLE=Song", "METADATA_BLOCK_PICTURE="+picture)...))
	var m Metadata
	var err error
	if n := allocated(func() { m, err = ReadFrom(bytes.NewReader(file)) }); n > 1<<20 {
		t.Errorf("Ogg picture of 4 GiB: allocated %d bytes", n)
	}
	if err != nil || m.Title() != "Song" || m.Picture() != nil {
		t.Errorf("Ogg picture of 4 GiB: got %v; want the title and no picture", err)
	}
}

// Sizes too small for what has to follow them are errors. They're unsigned,
// so they used to wrap round into huge reads; for ID3v2 frames that read
// quietly returned nothing and parsing carried on from inside the frame.
func TestSizeUnderflows(t *testing.T) {
	be32 := binary.BigEndian.AppendUint32
	m4a := func(item []byte) []byte {
		file := append(atom("ftyp", []byte("M4A "), make([]byte, 4)), 0, 0, 0, 8, 'i', 'l', 's', 't')
		return append(append(file, item...), make([]byte, 64)...)
	}
	for name, file := range map[string][]byte{
		"ID3v2.4 extended header under 4 bytes": id3v2Tag(4, 0x40, syncsafe(2), make([]byte, 64)),
		// Compression flag, 2 bytes: too short for the 4-byte decompressed size.
		"ID3v2.3 compressed frame under 4 bytes": id3v2Tag(3, 0, []byte("TIT2\x00\x00\x00\x02\x00\x80"), make([]byte, 64)),
		// Encryption and data length flags, with a data length of 0: no room
		// for the encryption method byte.
		"ID3v2.4 encrypted frame of 0 bytes": id3v2Tag(4, 0, []byte("TIT2\x00\x00\x00\x05\x00\x05"), make([]byte, 64)),
		"MP4 data atom under 8 bytes":        m4a(append(be32(nil, 4), "\xa9nam"...)),
		"MP4 custom sub-atom under 8 bytes":  m4a(atom("----", append(be32(nil, 0), "mean"...), make([]byte, 16))),
	} {
		if _, err := ReadFrom(bytes.NewReader(file)); err == nil {
			t.Errorf("%s: parsed without error", name)
		}
	}
}

// A custom ---- atom the reader doesn't recognise (here: no data atom) is
// skipped once. Upstream skipped it twice, losing the atom after it.
func TestMP4CustomAtomWithoutData(t *testing.T) {
	ilst := atom("ilst",
		atom("----",
			atom("mean", make([]byte, 4), []byte("com.apple.iTunes")),
			atom("name", make([]byte, 4), []byte("iTunNORM"))),
		ilstItem("\xa9nam", 1, []byte("Title")),
	)
	file := append(atom("ftyp", []byte("M4A "), make([]byte, 4)),
		atom("moov", atom("udta", atom("meta", make([]byte, 4), ilst)))...)
	m, err := ReadFrom(bytes.NewReader(file))
	if err != nil {
		t.Fatal(err)
	}
	if got := m.Title(); got != "Title" {
		t.Fatalf("title = %q, want %q", got, "Title")
	}
}

// A skipped atom too small for its own header ends the walk with the tags
// found so far, as upstream's underflowed seek did. Size 0 (the atom runs to
// the end of the file) and 1 (a 64-bit size follows) are legal for media data.
func TestMP4SkippedAtomSizes(t *testing.T) {
	for _, header := range [][]byte{
		[]byte("\x00\x00\x00\x00mdat"),
		[]byte("\x00\x00\x00\x01mdat\x00\x00\x00\x01\x00\x00\x00\x00"),
		[]byte("\x00\x00\x00\x05free"),
	} {
		file := bytes.Join([][]byte{fixture(t, "with_tags/sample.m4a"), header, []byte("audio")}, nil)
		m, err := ReadFrom(bytes.NewReader(file))
		if err != nil {
			t.Fatalf("%q: %v", header, err)
		}
		compareMetadata(t, m, fullMetadata)
	}
}

// repeatReader yields b over and over.
type repeatReader struct {
	b   []byte
	off int
}

func (r *repeatReader) Read(p []byte) (int, error) {
	n := copy(p, r.b[r.off:])
	r.off = (r.off + n) % len(r.b)
	return n, nil
}

// An Ogg packet continued from page to page stops at the field cap instead of
// buffering the whole stream.
func TestOGGPacketLimit(t *testing.T) {
	lacing := bytes.Repeat([]byte{255}, 255)
	data := make([]byte, 255*255)
	first, more := oggPage(0, 0, lacing, data), oggPage(1, 1, lacing, data)
	stream := io.LimitReader(&repeatReader{b: more}, 2*readBytesMax)
	counted := &countingReader{r: io.MultiReader(bytes.NewReader(first), stream)}
	if _, err := ReadOGGTags(counted); err == nil {
		t.Fatal("no error")
	}
	if limit := (readBytesMax/len(data) + 2) * len(more); counted.n > limit {
		t.Fatalf("read %d bytes, want the reader to stop within %d", counted.n, limit)
	}
}

type countingReader struct {
	r io.Reader
	n int
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += n
	return n, err
}

// unsync applies ID3 unsynchronisation: a zero after every 0xFF.
func unsync(b []byte) []byte {
	var out []byte
	for _, c := range b {
		out = append(out, c)
		if c == 0xff {
			out = append(out, 0)
		}
	}
	return out
}

// readCounter counts the reads that reach the underlying file.
type readCounter struct {
	io.ReadSeeker
	reads int
}

func (r *readCounter) Read(p []byte) (int, error) {
	r.reads++
	return r.ReadSeeker.Read(p)
}

// An unsynchronised tag reads the same as a plain one, and through a buffer:
// upstream issued a read on the file for every byte.
func TestUnsynchronisedTag(t *testing.T) {
	private := append([]byte("lumen\x00"), bytes.Repeat([]byte{0xff, 0xe0}, 1<<20)...)
	body := unsync(append(id3v2Frame(3, "PRIV", private), id3v2Sample(3)[10:]...))
	file := append(append([]byte{'I', 'D', '3', 3, 0, 0x80}, syncsafe(len(body))...), body...)
	file = append(file, mp3Audio()...)

	r := &readCounter{ReadSeeker: bytes.NewReader(file)}
	m, err := ReadFrom(r)
	if err != nil {
		t.Fatal(err)
	}
	compareMetadata(t, m, fullMetadata)
	if p := m.Picture(); p == nil || !bytes.Equal(p.Data, samplePicture) {
		t.Errorf("picture = %v, want the sample's", p)
	}
	if got, _ := m.Raw()["PRIV"].([]byte); !bytes.Equal(got, private) {
		t.Errorf("PRIV frame of %d bytes, want %d", len(got), len(private))
	}
	if r.reads > len(file)/1024 {
		t.Errorf("%d reads for a %d-byte file", r.reads, len(file))
	}
}

// Expanding numeric genre references was quadratic in the genre's length: a
// 24 KB genre took 46 s. Long genres are now left as they are.
func TestLongGenre(t *testing.T) {
	long := strings.Repeat("(1)", 8000)
	var got string
	if n := allocated(func() { got = id3v2genre(long) }); n > 1<<20 {
		t.Errorf("allocated %d bytes", n)
	}
	if got != long {
		t.Error("a 24 KB genre was expanded")
	}
	short := strings.Repeat("(1)", maxGenreLen/3)
	if got := id3v2genre(short); strings.Contains(got, "(1)") {
		t.Errorf("a %d-byte genre wasn't expanded: %q", len(short), got)
	}
}

// Naming repeated ID3 frames was quadratic in the repeats: 40,000 copies of
// one frame took 52 s and allocated 12 GB. Past maxTagEntries frames (or
// Vorbis comments) the tag is refused.
func TestManyEntries(t *testing.T) {
	const repeats = 40000
	file := id3v2Tag(3, 0, bytes.Repeat(id3v2Frame(3, "PRIV", []byte("x")), repeats))
	var m Metadata
	var err error
	if n := allocated(func() { m, err = ReadFrom(bytes.NewReader(file)) }); n > 64<<20 {
		t.Errorf("%d repeated frames: allocated %d bytes", repeats, n)
	}
	if err != nil {
		t.Fatal(err)
	}
	last := fmt.Sprintf("PRIV_%d", repeats-2)
	if raw := m.Raw(); len(raw) != repeats || raw["PRIV"] == nil || raw["PRIV_0"] == nil || raw[last] == nil {
		t.Errorf("%d frames named PRIV, PRIV_0, ... %s; want %d", len(raw), last, repeats)
	}

	file = id3v2Tag(3, 0, bytes.Repeat(id3v2Frame(3, "PRIV", []byte("x")), maxTagEntries+1))
	if _, err := ReadFrom(bytes.NewReader(file)); err == nil {
		t.Errorf("a tag of %d frames parsed without error", maxTagEntries+1)
	}
	comments := make([]string, maxTagEntries+1)
	for i := range comments {
		comments[i] = "a=b"
	}
	file = append([]byte("fLaC"), flacBlock(4, true, vorbisComment(comments...))...)
	if _, err := ReadFrom(bytes.NewReader(file)); err == nil {
		t.Errorf("%d Vorbis comments parsed without error", len(comments))
	}
}

// FuzzReadFrom runs mutated samples through every reader and accessor,
// looking for panics. Plain go test runs only the seeds; fuzz with
// go test -run '^$' -fuzz FuzzReadFrom.
func FuzzReadFrom(f *testing.F) {
	for _, b := range fixtures {
		f.Add(b)
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		if m, err := ReadFrom(bytes.NewReader(b)); err == nil {
			readAll(m)
		}
		Identify(bytes.NewReader(b))
		Sum(bytes.NewReader(b))
	})
}
