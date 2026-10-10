package tidal

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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

// hlsMediaPlaylist builds a media playlist with the given header lines
// followed by n segments.
func hlsMediaPlaylist(header []string, n int) string {
	var b strings.Builder
	b.WriteString("#EXTM3U\n")
	for _, line := range header {
		b.WriteString(line + "\n")
	}
	for i := range n {
		fmt.Fprintf(&b, "#EXTINF:4.0,\nseg%d.m4s\n", i+1)
	}
	b.WriteString("#EXT-X-ENDLIST\n")
	return b.String()
}

func TestParseHLSPlaylistLimits(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		wantErr string
	}{
		{name: "segments at the cap", body: hlsMediaPlaylist(nil, maxHLSSegments)},
		{
			name:    "segments over the cap",
			body:    hlsMediaPlaylist(nil, maxHLSSegments+1),
			wantErr: fmt.Sprintf("more than %d segments", maxHLSSegments),
		},
		{
			// The cheapest hostile playlist: no tags, one byte per URI.
			name:    "bare one-byte uris",
			body:    strings.Repeat("s\n", 2<<20),
			wantErr: fmt.Sprintf("more than %d segments", maxHLSSegments),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseHLSPlaylist(tt.body)
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("parseHLSPlaylist returned error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("error = %v, want one containing %q", err, tt.wantErr)
			}
		})
	}
}

// TestFileResponseHLSFetchLimits checks that a download fetches each AES-128
// key once however often the playlist names it, and that playlists over the
// segment or key caps fail before anything is fetched from the media host.
func TestFileResponseHLSFetchLimits(t *testing.T) {
	streamClient, restore := allowLoopbackMedia()
	defer restore()

	iv := bytes.Repeat([]byte{7}, 16)
	keyLine := func(uri string) string {
		return `#EXT-X-KEY:METHOD=AES-128,URI="` + uri + `",IV=0x` + hex.EncodeToString(iv)
	}
	playlist := func(lines ...string) string {
		return "#EXTM3U\n" + strings.Join(lines, "\n") + "\n#EXT-X-ENDLIST\n"
	}
	var repeatedKey, tooManyKeys []string
	for i := range 50 {
		repeatedKey = append(repeatedKey, keyLine("keys/1.key"), "#EXTINF:4.0,", fmt.Sprintf("seg%d.m4s", i+1))
	}
	for i := range maxHLSKeys + 1 {
		tooManyKeys = append(tooManyKeys, keyLine(fmt.Sprintf("keys/%d.key", i+1)))
	}
	tooManyKeys = append(tooManyKeys, "#EXTINF:4.0,", "seg1.m4s")

	tests := []struct {
		name     string
		playlist string
		// wantSegments is how many segments, seg1.m4s onwards, the body holds.
		wantSegments int
		wantKeys     map[string]int
		wantErr      string
	}{
		{
			name:         "one key repeated before every segment",
			playlist:     playlist(repeatedKey...),
			wantSegments: 50,
			wantKeys:     map[string]int{"/media/keys/1.key": 1},
		},
		{
			name: "rotated keys named again in other spellings",
			playlist: playlist(
				keyLine("keys/1.key"), "#EXTINF:4.0,", "seg1.m4s",
				keyLine("keys/2.key"), "#EXTINF:4.0,", "seg2.m4s",
				keyLine("./keys/1.key"), "#EXTINF:4.0,", "seg3.m4s",
				keyLine("/media/keys/2.key"), "#EXTINF:4.0,", "seg4.m4s",
			),
			wantSegments: 4,
			wantKeys:     map[string]int{"/media/keys/1.key": 1, "/media/keys/2.key": 1},
		},
		{
			name:     "more distinct keys than the cap",
			playlist: playlist(tooManyKeys...),
			wantErr:  fmt.Sprintf("more than %d keys", maxHLSKeys),
		},
		{
			name:     "more segments than the cap",
			playlist: hlsMediaPlaylist(nil, maxHLSSegments+1),
			wantErr:  fmt.Sprintf("more than %d segments", maxHLSSegments),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var mu sync.Mutex
			keyFetches := map[string]int{}
			segmentFetches := 0
			var srv *httptest.Server
			srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.URL.Path == "/trackManifests/":
					mediaURL := srv.URL + "/media/playlist.m3u8"
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{"version":"2.10","data":{"data":{"attributes":{"trackPresentation":"FULL","uri":"` + mediaURL + `"}}}}`))
				case r.URL.Path == "/media/playlist.m3u8":
					w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
					_, _ = w.Write([]byte(tt.playlist))
				case strings.HasPrefix(r.URL.Path, "/media/keys/"):
					mu.Lock()
					keyFetches[r.URL.Path]++
					mu.Unlock()
					_, _ = w.Write(aesKeyFixture)
				case strings.HasPrefix(r.URL.Path, "/media/seg"):
					mu.Lock()
					segmentFetches++
					mu.Unlock()
					_, _ = w.Write(encryptAES128CBC([]byte(r.URL.Path[len("/media/"):]), aesKeyFixture, iv))
				case r.URL.Path == "/track/":
					http.Error(w, "no fallback", http.StatusInternalServerError)
				default:
					t.Errorf("unexpected path: %s", r.URL.Path)
				}
			}))
			defer srv.Close()

			c := NewClient(Config{HifiAPIURL: srv.URL, Quality: "LOSSLESS"})
			c.stream = streamClient
			resp, err := c.FileResponse(context.Background(), "123", nil)
			if tt.wantErr != "" {
				if err == nil {
					resp.Body.Close()
					t.Fatalf("FileResponse succeeded, want error containing %q", tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("error = %v, want one containing %q", err, tt.wantErr)
				}
				if len(keyFetches) != 0 || segmentFetches != 0 {
					t.Fatalf("fetched keys %v and %d segments before failing", keyFetches, segmentFetches)
				}
				return
			}
			if err != nil {
				t.Fatalf("FileResponse returned error: %v", err)
			}
			body, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil {
				t.Fatalf("read body: %v", err)
			}
			var want strings.Builder
			for i := range tt.wantSegments {
				fmt.Fprintf(&want, "seg%d.m4s", i+1)
			}
			if string(body) != want.String() {
				t.Fatalf("body = %q, want %q", body, want.String())
			}
			mu.Lock()
			defer mu.Unlock()
			if fmt.Sprint(keyFetches) != fmt.Sprint(tt.wantKeys) {
				t.Fatalf("key fetches = %v, want %v", keyFetches, tt.wantKeys)
			}
		})
	}
}
