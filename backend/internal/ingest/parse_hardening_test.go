package ingest

// Crafted uploads used to take the server down from inside the tag parser.
// They must come back from ParseFile as ordinary results or errors.

import (
	"bytes"
	"context"
	"encoding/binary"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/githubesson/lumen/internal/thirdparty/tag"
)

func writeTestFile(t *testing.T, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func mp4Atom(name string, parts ...[]byte) []byte {
	body := bytes.Join(parts, nil)
	return append(binary.BigEndian.AppendUint32(nil, uint32(8+len(body))), append([]byte(name), body...)...)
}

func m4aFile(atoms ...[]byte) []byte {
	ftyp := mp4Atom("ftyp", []byte("M4A "), make([]byte, 4))
	return bytes.Join(append([][]byte{ftyp}, atoms...), nil)
}

func TestParseFileCraftedM4A(t *testing.T) {
	// Some 6.5 million nested moov headers overflowed the goroutine stack,
	// which no recover catches. The parser now gives up 32 levels in.
	deep := m4aFile(bytes.Repeat([]byte{0, 0, 0, 8, 'm', 'o', 'o', 'v'}, 1<<16))
	if _, err := ParseFile(writeTestFile(t, "deep.m4a", deep)); err == nil {
		t.Error("deeply nested atoms parsed without error")
	}

	// Data class 21 makes the title an int, which panicked m.Title(). It now
	// reads as no title, and the file name stands in.
	title := mp4Atom("\xa9nam", mp4Atom("data", []byte{0, 0, 0, 21}, make([]byte, 4), []byte{7}))
	confused := m4aFile(mp4Atom("moov", mp4Atom("udta", mp4Atom("meta", make([]byte, 4), mp4Atom("ilst", title)))))
	md, err := ParseFile(writeTestFile(t, "Song Name.m4a", confused))
	if err != nil {
		t.Fatal(err)
	}
	if md.Title != "Song Name" {
		t.Errorf("title %q, want the file name", md.Title)
	}
}

// A 49-byte FLAC claiming a 4 GiB picture made the parser allocate it.
func TestParseFileLyingFLACPicture(t *testing.T) {
	picture := binary.BigEndian.AppendUint32(make([]byte, 28), 0xffffffff)
	header := []byte{0x86, 0, 0, byte(len(picture))} // last block, type 6 (picture)
	file := append(append(append([]byte("fLaC"), header...), picture...), "audio"...)
	path := writeTestFile(t, "cover.flac", file)

	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	_, err := ParseFile(path)
	runtime.ReadMemStats(&after)
	if err == nil {
		t.Error("parsed without error")
	}
	if n := after.TotalAlloc - before.TotalAlloc; n > 1<<20 {
		t.Errorf("allocated %d bytes", n)
	}
}

// messages is a slog.Handler that passes on each record's message.
type messages chan string

func (h messages) Enabled(context.Context, slog.Level) bool { return true }
func (h messages) WithAttrs([]slog.Attr) slog.Handler       { return h }
func (h messages) WithGroup(string) slog.Handler            { return h }

func (h messages) Handle(_ context.Context, r slog.Record) error {
	select {
	case h <- r.Message:
	default:
	}
	return nil
}

// logTo sends the default logger's messages to a channel for the test.
func logTo(t *testing.T) messages {
	logged := make(messages, 16)
	prev := slog.Default()
	slog.SetDefault(slog.New(logged))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return logged
}

type panickingReader struct{}

func (panickingReader) Read([]byte) (int, error)       { panic("read") }
func (panickingReader) Seek(int64, int) (int64, error) { panic("seek") }

// panickingTags panics in every accessor: they call through a nil interface.
type panickingTags struct{ tag.Metadata }

// A panic left anywhere in the tag library fails the file instead of the
// upload request or, off the request path, the whole server.
func TestTagPanicsBecomeErrors(t *testing.T) {
	logged := logTo(t)
	if md, err := parse(panickingReader{}, "song.mp3"); md != nil || err == nil {
		t.Errorf("parse with a panicking reader = %v, %v; want an error", md, err)
	}
	if md, err := fromTags(panickingTags{}, "song.mp3"); md != nil || err == nil {
		t.Errorf("fromTags with panicking accessors = %v, %v; want an error", md, err)
	}
	if sum, err := tagSum(panickingReader{}); sum != "" || err == nil {
		t.Errorf("tagSum with a panicking reader = %q, %v; want an error", sum, err)
	}
	for i := 0; i < 3; i++ {
		if msg := <-logged; msg != "tag parser panicked" {
			t.Errorf("logged %q, want the panic", msg)
		}
	}
}
