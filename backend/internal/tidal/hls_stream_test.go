package tidal

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type segmentTestBody struct {
	read   func([]byte) (int, error)
	closed bool
}

func (b *segmentTestBody) Read(p []byte) (int, error) { return b.read(p) }
func (b *segmentTestBody) Close() error               { b.closed = true; return nil }

type segmentTestWriter func([]byte) (int, error)

func (w segmentTestWriter) Write(p []byte) (int, error) { return w(p) }

func TestUnencryptedHLSSegmentStreamsBeforeEOF(t *testing.T) {
	var out bytes.Buffer
	reads := 0
	body := &segmentTestBody{read: func(p []byte) (int, error) {
		reads++
		if reads == 1 {
			return copy(p, "first"), nil
		}
		if out.String() != "first" {
			return 0, errors.New("first chunk was buffered instead of streamed")
		}
		return copy(p, "second"), io.EOF
	}}
	resp := &http.Response{StatusCode: http.StatusOK, Body: body}
	if err := writeHLSSegment(resp, segmentTestWriter(out.Write), -1, nil, nil, 0); err != nil {
		t.Fatal(err)
	}
	if out.String() != "firstsecond" || !body.closed {
		t.Fatalf("output = %q, body closed = %v", out.String(), body.closed)
	}
}

func TestHLSSegmentRejectsStatusBeforeReading(t *testing.T) {
	body := &segmentTestBody{read: func([]byte) (int, error) {
		t.Fatal("read the error response body")
		return 0, io.EOF
	}}
	resp := &http.Response{StatusCode: http.StatusForbidden, Status: "403 Forbidden", Body: body}
	err := writeHLSSegment(resp, io.Discard, -1, nil, nil, 0)
	if err == nil || !strings.Contains(err.Error(), "403") || !body.closed {
		t.Fatalf("error = %v, body closed = %v", err, body.closed)
	}
}

func TestEncryptedHLSSegmentSizeLimit(t *testing.T) {
	for _, knownLength := range []bool{true, false} {
		t.Run(map[bool]string{true: "content length", false: "unknown length"}[knownLength], func(t *testing.T) {
			read := 0
			body := &segmentTestBody{read: func(p []byte) (int, error) {
				read += len(p)
				clear(p)
				return len(p), nil
			}}
			resp := &http.Response{StatusCode: http.StatusOK, Body: body, ContentLength: -1}
			if knownLength {
				resp.ContentLength = maxEncryptedHLSSegmentBytes + 1
			}
			err := writeHLSSegment(resp, io.Discard, 0, [][]byte{make([]byte, 16)}, []hlsKeyRef{{}}, 0)
			if err == nil || !strings.Contains(err.Error(), "size limit") || !body.closed {
				t.Fatalf("error = %v, body closed = %v", err, body.closed)
			}
			wantRead := maxEncryptedHLSSegmentBytes + 1
			if knownLength {
				wantRead = 0
			}
			if read != wantRead {
				t.Fatalf("read %d bytes, want %d", read, wantRead)
			}
		})
	}
}

func TestHLSSegmentClosesBodyWhenOutputFails(t *testing.T) {
	input := strings.NewReader("audio")
	body := &segmentTestBody{read: input.Read}
	outputErr := errors.New("consumer disconnected")
	resp := &http.Response{StatusCode: http.StatusOK, Body: body}
	err := writeHLSSegment(resp, segmentTestWriter(func([]byte) (int, error) {
		return 0, outputErr
	}), -1, nil, nil, 0)
	if !errors.Is(err, outputErr) || !body.closed {
		t.Fatalf("error = %v, body closed = %v", err, body.closed)
	}
}
