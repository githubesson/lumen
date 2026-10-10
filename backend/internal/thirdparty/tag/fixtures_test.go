package tag

// Samples for TestReadFrom, built in code: upstream reads them from a testdata
// directory of real files, which Lumen's fork leaves out. The tagged ones carry
// the values testdata/README.md lists upstream (fullMetadata).

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"testing"
)

// fixture returns the sample upstream keeps at testdata/<path>.
func fixture(t *testing.T, path string) []byte {
	t.Helper()
	b, ok := fixtures[path]
	if !ok {
		t.Fatalf("no fixture for %q", path)
	}
	return b
}

var fixtures = map[string][]byte{
	"with_tags/sample.flac":          flacSample(true),
	"with_tags/sample.id3v11.mp3":    append(mp3Audio(), id3v1Sample()...),
	"with_tags/sample.id3v22.mp3":    append(id3v2Sample(2), mp3Audio()...),
	"with_tags/sample.id3v23.mp3":    append(id3v2Sample(3), mp3Audio()...),
	"with_tags/sample.id3v24.mp3":    append(id3v2Sample(4), mp3Audio()...),
	"with_tags/sample.m4a":           mp4Sample("M4A ", true),
	"with_tags/sample.mp4":           mp4Sample("mp42", true),
	"with_tags/sample.ogg":           oggVorbisSample(true),
	"with_tags/sample.multipage.ogg": opusSample(),
	"with_tags/sample.dsf":           dsfSample(),
	"without_tags/sample.flac":       flacSample(false),
	"without_tags/sample.m4a":        mp4Sample("M4A ", false),
	"without_tags/sample.mp3":        mp3Audio(),
	"without_tags/sample.mp4":        mp4Sample("mp42", false),
	"without_tags/sample.ogg":        oggVorbisSample(false),
}

// samplePicture stands in for cover art; the readers never decode it.
var samplePicture = []byte("\xff\xd8\xff\xe0 not really a JPEG \xff\xd9")

// opusCover is big enough that its base64 pushes the OpusTags packet across
// several Ogg pages, like upstream's sample.multipage.ogg.
var opusCover = bytes.Repeat(samplePicture, 4096)

var sampleComments = []string{
	"TITLE=Test Title",
	"ARTIST=Test Artist",
	"ALBUM=Test Album",
	"ALBUMARTIST=Test AlbumArtist",
	"COMPOSER=Test Composer",
	"GENRE=Jazz",
	"DATE=2000",
	"TRACKNUMBER=3",
	"TRACKTOTAL=06",
	"DISCNUMBER=02",
	"COMMENT=Test Comment",
}

// mp3Audio is a frame header and silence: enough bytes for an ID3v1 trailer
// check, none of them "TAG".
func mp3Audio() []byte {
	return append([]byte{0xff, 0xfb, 0x90, 0x64}, make([]byte, 413)...)
}

func id3v1Sample() []byte {
	field := func(s string, n int) []byte {
		b := make([]byte, n)
		copy(b, s)
		return b
	}
	b := []byte("TAG")
	b = append(b, field("Test Title", 30)...)
	b = append(b, field("Test Artist", 30)...)
	b = append(b, field("Test Album", 30)...)
	b = append(b, "2000"...)
	comment := field("Test Comment", 30)
	comment[29] = 3 // ID3v1.1: a zero in byte 28 makes byte 29 the track
	b = append(b, comment...)
	return append(b, 8) // genre 8 is Jazz
}

func syncsafe(n int) []byte {
	return []byte{byte(n>>21) & 0x7f, byte(n>>14) & 0x7f, byte(n>>7) & 0x7f, byte(n) & 0x7f}
}

// id3v2Frame builds one frame: a 3-byte ID and size in v2.2; a 4-byte ID, a
// size (plain in v2.3, syncsafe in v2.4) and two flag bytes after that.
func id3v2Frame(version byte, id string, data []byte) []byte {
	var b []byte
	switch version {
	case 2:
		b = append([]byte(id), byte(len(data)>>16), byte(len(data)>>8), byte(len(data)))
	case 3:
		b = append(binary.BigEndian.AppendUint32([]byte(id), uint32(len(data))), 0, 0)
	default:
		b = append(append([]byte(id), syncsafe(len(data))...), 0, 0)
	}
	return append(b, data...)
}

// id3v2Tag wraps frames in a tag header with the given header flags.
func id3v2Tag(version, flags byte, frames ...[]byte) []byte {
	body := bytes.Join(frames, nil)
	return append(append([]byte{'I', 'D', '3', version, 0, flags}, syncsafe(len(body))...), body...)
}

func id3v2Sample(version byte) []byte {
	// title, artist, album, album artist, composer, year, track, disc, genre,
	// comment, picture
	ids := map[byte][]string{
		2: {"TT2", "TP1", "TAL", "TP2", "TCM", "TYE", "TRK", "TPA", "TCO", "COM", "PIC"},
		3: {"TIT2", "TPE1", "TALB", "TPE2", "TCOM", "TYER", "TRCK", "TPOS", "TCON", "COMM", "APIC"},
		4: {"TIT2", "TPE1", "TALB", "TPE2", "TCOM", "TDRC", "TRCK", "TPOS", "TCON", "COMM", "APIC"},
	}[version]
	text := func(id, s string) []byte { return id3v2Frame(version, id, append([]byte{0}, s...)) }
	// Older taggers write the genre as an ID3v1 number; id3v2genre expands it.
	genre := "(8)"
	if version == 4 {
		genre = "Jazz"
	}
	pic := []byte("\x00image/jpeg\x00\x03\x00") // encoding, MIME, front cover, no description
	if version == 2 {
		pic = []byte("\x00jpg\x03\x00")
	}
	return id3v2Tag(version, 0,
		text(ids[0], "Test Title"),
		text(ids[1], "Test Artist"),
		text(ids[2], "Test Album"),
		text(ids[3], "Test AlbumArtist"),
		text(ids[4], "Test Composer"),
		text(ids[5], "2000"),
		text(ids[6], "3/6"),
		text(ids[7], "2"),
		text(ids[8], genre),
		id3v2Frame(version, ids[9], []byte("\x00eng\x00Test Comment")),
		id3v2Frame(version, ids[10], append(pic, samplePicture...)),
		make([]byte, 64), // padding
	)
}

func flacBlock(typ byte, last bool, body []byte) []byte {
	h := []byte{typ, byte(len(body) >> 16), byte(len(body) >> 8), byte(len(body))}
	if last {
		h[0] |= 0x80
	}
	return append(h, body...)
}

func vorbisComment(comments ...string) []byte {
	le := binary.LittleEndian.AppendUint32
	b := append(le(nil, 5), "Lumen"...) // vendor
	b = le(b, uint32(len(comments)))
	for _, c := range comments {
		b = append(le(b, uint32(len(c))), c...)
	}
	return b
}

// flacPicture is a FLAC PICTURE block body, also the payload of a Vorbis
// METADATA_BLOCK_PICTURE comment.
func flacPicture(mime string, data []byte) []byte {
	be := binary.BigEndian.AppendUint32
	b := be(nil, 3) // front cover
	b = append(be(b, uint32(len(mime))), mime...)
	b = be(b, 0)                       // description
	b = append(b, make([]byte, 16)...) // width, height, depth, colours
	return append(be(b, uint32(len(data))), data...)
}

func flacSample(tagged bool) []byte {
	b := append([]byte("fLaC"), flacBlock(0, !tagged, make([]byte, 34))...)
	if tagged {
		b = append(b, flacBlock(4, false, vorbisComment(sampleComments...))...)
		b = append(b, flacBlock(1, false, make([]byte, 100))...) // padding
		b = append(b, flacBlock(6, true, flacPicture("image/jpeg", samplePicture))...)
	}
	return append(b, 0xff, 0xf8, 0x69, 0x08) // start of an audio frame
}

// oggPages lays packets out over as many Ogg pages as they need (255 lacing
// values each), with valid checksums.
func oggPages(packets ...[]byte) []byte {
	var lacing, data []byte
	for _, p := range packets {
		n := len(p)
		for ; n >= 255; n -= 255 {
			lacing = append(lacing, 255)
		}
		lacing = append(lacing, byte(n))
		data = append(data, p...)
	}
	var out []byte
	continued := false
	for seq := uint32(0); len(lacing) > 0; seq++ {
		segs := lacing[:min(len(lacing), 255)]
		size := 0
		for _, s := range segs {
			size += int(s)
		}
		var flags byte
		if continued {
			flags = 1
		}
		out = append(out, oggPage(flags, seq, segs, data[:size])...)
		continued = segs[len(segs)-1] == 255
		lacing, data = lacing[len(segs):], data[size:]
	}
	return out
}

// oggPage builds one page of stream 1 from its lacing values and their data.
func oggPage(flags byte, seq uint32, lacing, data []byte) []byte {
	page := append([]byte("OggS"), 0, flags)
	page = binary.LittleEndian.AppendUint64(page, 0) // granule position
	page = binary.LittleEndian.AppendUint32(page, 1) // serial
	page = binary.LittleEndian.AppendUint32(page, seq)
	page = append(page, 0, 0, 0, 0, byte(len(lacing)))
	page = append(append(page, lacing...), data...)
	binary.LittleEndian.PutUint32(page[22:], oggCRCUpdate(0, oggCRC32Poly04c11db7, page))
	return page
}

func oggVorbisSample(tagged bool) []byte {
	var comments []string
	if tagged {
		comments = sampleComments
	}
	ident := append([]byte("\x01vorbis"), make([]byte, 23)...)
	comment := append(append([]byte("\x03vorbis"), vorbisComment(comments...)...), 1) // framing bit
	setup := append([]byte("\x05vorbis"), make([]byte, 40)...)
	return append(oggPages(ident), oggPages(comment, setup)...)
}

func opusSample() []byte {
	head := append([]byte("OpusHead"), 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0)
	picture := base64.StdEncoding.EncodeToString(flacPicture("image/jpeg", opusCover))
	comments := append(append([]string(nil), sampleComments...), "METADATA_BLOCK_PICTURE="+picture)
	tags := append([]byte("OpusTags"), vorbisComment(comments...)...)
	return append(oggPages(head), oggPages(tags)...)
}

func atom(name string, parts ...[]byte) []byte {
	body := bytes.Join(parts, nil)
	return append(binary.BigEndian.AppendUint32(nil, uint32(8+len(body))), append([]byte(name), body...)...)
}

// ilstItem is a metadata item holding one data atom of the given class.
func ilstItem(name string, class byte, value []byte) []byte {
	return atom(name, atom("data", []byte{0, 0, 0, class}, []byte{0, 0, 0, 0}, value))
}

func mp4Sample(brand string, tagged bool) []byte {
	ftyp := atom("ftyp", []byte(brand), []byte{0, 0, 2, 0}, []byte(brand+"isom"))
	moov := [][]byte{atom("mvhd", make([]byte, 100))}
	if tagged {
		ilst := atom("ilst",
			ilstItem("\xa9nam", 1, []byte("Test Title")),
			ilstItem("\xa9ART", 1, []byte("Test Artist")),
			ilstItem("\xa9alb", 1, []byte("Test Album")),
			ilstItem("aART", 1, []byte("Test AlbumArtist")),
			ilstItem("\xa9wrt", 1, []byte("Test Composer")),
			ilstItem("\xa9gen", 1, []byte("Jazz")),
			ilstItem("\xa9day", 1, []byte("2000")),
			ilstItem("trkn", 0, []byte{0, 0, 0, 3, 0, 6, 0, 0}),
			ilstItem("disk", 0, []byte{0, 0, 0, 2, 0, 0}),
			ilstItem("\xa9cmt", 1, []byte("Test Comment")),
			ilstItem("covr", 13, samplePicture),
		)
		hdlr := atom("hdlr", make([]byte, 25))
		moov = append(moov, atom("udta", atom("meta", []byte{0, 0, 0, 0}, hdlr, ilst)))
	}
	return append(append(ftyp, atom("moov", moov...)...), atom("mdat", mp3Audio())...)
}

// dsfSample is a DSD stream file: a DSD chunk pointing at an ID3v2 tag after
// the audio.
func dsfSample() []byte {
	tag := id3v2Sample(3)
	audio := make([]byte, 64)
	le := binary.LittleEndian.AppendUint64
	b := le(le([]byte("DSD "), 28), uint64(28+len(audio)+len(tag)))
	b = le(b, uint64(28+len(audio)))
	return append(append(b, audio...), tag...)
}

func TestReadFromPictures(t *testing.T) {
	for path, want := range map[string][]byte{
		"with_tags/sample.flac":          samplePicture,
		"with_tags/sample.id3v22.mp3":    samplePicture,
		"with_tags/sample.id3v23.mp3":    samplePicture,
		"with_tags/sample.id3v24.mp3":    samplePicture,
		"with_tags/sample.m4a":           samplePicture,
		"with_tags/sample.multipage.ogg": opusCover,
		"with_tags/sample.dsf":           samplePicture,
	} {
		m, err := ReadFrom(bytes.NewReader(fixture(t, path)))
		if err != nil {
			t.Errorf("%s: %v", path, err)
			continue
		}
		p := m.Picture()
		if p == nil || p.MIMEType != "image/jpeg" || !bytes.Equal(p.Data, want) {
			t.Errorf("%s: picture = %v, want a %d-byte image/jpeg", path, p, len(want))
		}
	}
}
