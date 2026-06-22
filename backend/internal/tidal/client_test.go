package tidal

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/githubesson/lumen/internal/httpx"
)

func TestRewriteHLSPlaylist(t *testing.T) {
	playlist := strings.Join([]string{
		"#EXTM3U",
		`#EXT-X-KEY:METHOD=AES-128,URI="keys/1.key"`,
		"#EXTINF:4.0,",
		"segment-1.mp4",
		"#EXT-X-STREAM-INF:BANDWIDTH=1000",
		"https://im-fa.manifest.tidal.com/nested/playlist.m3u8?token=abc",
		"",
	}, "\n")

	got := rewriteHLSPlaylist(playlist, "https://im-fa.manifest.tidal.com/root/master.m3u8?token=abc", func(raw string) string {
		return "/proxy?u=" + raw
	})

	for _, want := range []string{
		`URI="/proxy?u=https://im-fa.manifest.tidal.com/root/keys/1.key"`,
		"/proxy?u=https://im-fa.manifest.tidal.com/root/segment-1.mp4",
		"/proxy?u=https://im-fa.manifest.tidal.com/nested/playlist.m3u8?token=abc",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("rewritten playlist missing %q:\n%s", want, got)
		}
	}
}

func TestHifiQualityAttempts(t *testing.T) {
	tests := []struct {
		quality string
		want    []string
	}{
		{quality: "LOSSLESS", want: []string{"LOSSLESS", "HIGH", "LOW"}},
		{quality: "MAX", want: []string{"HI_RES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"}},
		{quality: "HIGH", want: []string{"HIGH", "LOW"}},
		{quality: "LOW", want: []string{"LOW"}},
	}
	for _, tt := range tests {
		t.Run(tt.quality, func(t *testing.T) {
			got := hifiQualityAttempts(tt.quality)
			if strings.Join(got, ",") != strings.Join(tt.want, ",") {
				t.Fatalf("hifiQualityAttempts(%q) = %v, want %v", tt.quality, got, tt.want)
			}
		})
	}
}

func TestHifiManifestFormats(t *testing.T) {
	tests := []struct {
		quality string
		want    []string
	}{
		{quality: "LOSSLESS", want: []string{"FLAC", "AACLC", "HEAACV1"}},
		{quality: "MAX", want: []string{"FLAC_HIRES", "FLAC", "AACLC", "HEAACV1"}},
		{quality: "HIGH", want: []string{"AACLC", "HEAACV1"}},
		{quality: "LOW", want: []string{"HEAACV1"}},
	}
	for _, tt := range tests {
		t.Run(tt.quality, func(t *testing.T) {
			got := hifiManifestFormats(tt.quality)
			if strings.Join(got, ",") != strings.Join(tt.want, ",") {
				t.Fatalf("hifiManifestFormats(%q) = %v, want %v", tt.quality, got, tt.want)
			}
		})
	}
}

func TestHifiTrackManifestReturnsHLSURI(t *testing.T) {
	wantURL := "https://im-fa.manifest.tidal.com/1/manifests/test.m3u8?token=abc"
	var gotManifestType string
	var gotFormats []string
	trackCalled := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/trackManifests/":
			if r.URL.Query().Get("id") != "123" {
				t.Fatalf("id = %q, want 123", r.URL.Query().Get("id"))
			}
			gotManifestType = r.URL.Query().Get("manifestType")
			gotFormats = r.URL.Query()["formats"]
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"version":"2.10","data":{"data":{"attributes":{"trackPresentation":"FULL","uri":"` + wantURL + `","formats":["FLAC"]}}}}`))
		case "/track/":
			trackCalled = true
			http.Error(w, "should not fallback", http.StatusInternalServerError)
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	c := NewClient(Config{HifiAPIURL: srv.URL, Quality: "LOSSLESS"})
	got, err := c.StreamURL(context.Background(), "123")
	if err != nil {
		t.Fatalf("StreamURL returned error: %v", err)
	}
	if got != wantURL {
		t.Fatalf("StreamURL = %q, want %q", got, wantURL)
	}
	if gotManifestType != "HLS" {
		t.Fatalf("manifestType = %q, want HLS", gotManifestType)
	}
	if strings.Join(gotFormats, ",") != "FLAC,AACLC,HEAACV1" {
		t.Fatalf("formats = %v", gotFormats)
	}
	if trackCalled {
		t.Fatal("/track/ fallback was called")
	}
}

func TestHifiResolverExtractsStreamURL(t *testing.T) {
	wantURL := "https://lgf.audio.tidal.com/mediatracks/test/0.flac?token=abc"
	manifest := base64.StdEncoding.EncodeToString([]byte(`{"urls":["` + wantURL + `"]}`))
	var gotQuality string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/trackManifests/" {
			http.Error(w, "hls unavailable", http.StatusBadGateway)
			return
		}
		if r.URL.Path != "/track/" {
			t.Fatalf("path = %q, want /track/", r.URL.Path)
		}
		if r.URL.Query().Get("id") != "123" {
			t.Fatalf("id = %q, want 123", r.URL.Query().Get("id"))
		}
		gotQuality = r.URL.Query().Get("quality")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"2.10","data":{"assetPresentation":"FULL","audioQuality":"LOSSLESS","manifestMimeType":"application/vnd.tidal.bts","manifest":"` + manifest + `"}}`))
	}))
	defer srv.Close()

	c := NewClient(Config{HifiAPIURL: srv.URL, Quality: "LOSSLESS"})
	got, err := c.StreamURL(context.Background(), "123")
	if err != nil {
		t.Fatalf("StreamURL returned error: %v", err)
	}
	if got != wantURL {
		t.Fatalf("StreamURL = %q, want %q", got, wantURL)
	}
	if gotQuality != "LOSSLESS" {
		t.Fatalf("quality = %q, want LOSSLESS", gotQuality)
	}
}

func TestHifiSearchTracks(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/search/" {
			t.Fatalf("path = %q, want /search/", r.URL.Path)
		}
		gotQuery = r.URL.Query().Get("s")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"2.10","data":{"items":[{"id":487833029,"title":"Nakamura","duration":185,"trackNumber":1,"volumeNumber":1,"artist":{"name":"Lil Uzi Vert"},"artists":[{"name":"Lil Uzi Vert"}],"album":{"id":123,"title":"Eternal Atake 2","cover":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}}]}}`))
	}))
	defer srv.Close()

	c := NewClient(Config{HifiAPIURL: srv.URL})
	tracks, err := c.SearchTracks(context.Background(), "Nakamura", 25, 0)
	if err != nil {
		t.Fatalf("SearchTracks returned error: %v", err)
	}
	if gotQuery != "Nakamura" {
		t.Fatalf("query = %q, want Nakamura", gotQuery)
	}
	if len(tracks) != 1 {
		t.Fatalf("len(tracks) = %d, want 1", len(tracks))
	}
	if tracks[0].ID != "487833029" || tracks[0].Title != "Nakamura" || tracks[0].Artists[0] != "Lil Uzi Vert" {
		t.Fatalf("unexpected track: %+v", tracks[0])
	}
}

func TestHifiAlbum(t *testing.T) {
	var gotID, gotLimit string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/album/" {
			t.Fatalf("path = %q, want /album/", r.URL.Path)
		}
		gotID = r.URL.Query().Get("id")
		gotLimit = r.URL.Query().Get("limit")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"2.10","data":{"id":58990510,"title":"OK Computer","duration":3216,"numberOfTracks":12,"releaseDate":"1997-07-01","cover":"e77e4cc0-6cd0-4522-807d-88aeac488065","artist":{"name":"Radiohead"},"items":[{"type":"track","item":{"id":58990511,"title":"Airbag","duration":287,"trackNumber":1,"volumeNumber":1,"artist":{"name":"Radiohead"},"artists":[{"name":"Radiohead"}],"album":{"id":58990510,"title":"OK Computer","cover":"e77e4cc0-6cd0-4522-807d-88aeac488065"}}}]}}`))
	}))
	defer srv.Close()

	c := NewClient(Config{HifiAPIURL: srv.URL})
	album, err := c.Album(context.Background(), "58990510", 100, 0)
	if err != nil {
		t.Fatalf("Album returned error: %v", err)
	}
	if gotID != "58990510" || gotLimit != "100" {
		t.Fatalf("query id=%q limit=%q, want id=58990510 limit=100", gotID, gotLimit)
	}
	if album.ID != "58990510" || album.Title != "OK Computer" || album.Artist != "Radiohead" {
		t.Fatalf("unexpected album: %+v", album)
	}
	if len(album.Tracks) != 1 || album.Tracks[0].ID != "58990511" || album.Tracks[0].AlbumID != "58990510" {
		t.Fatalf("unexpected album tracks: %+v", album.Tracks)
	}
}

func TestHifiStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			t.Fatalf("path = %q, want /", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"2.10","Repo":"https://github.com/binimum/hifi-api"}`))
	}))
	defer srv.Close()

	c := NewClient(Config{HifiAPIURL: srv.URL, CountryCode: "PL", Quality: "LOSSLESS"})
	status, err := c.Status(context.Background())
	if err != nil {
		t.Fatalf("Status returned error: %v", err)
	}
	if !status.Connected {
		t.Fatal("status.Connected = false, want true")
	}
	if status.Version != "2.10" || status.CountryCode != "PL" || status.Quality != "LOSSLESS" {
		t.Fatalf("unexpected status: %+v", status)
	}
}

// hifiMediaServer stands up a fake hifi-api plus a TIDAL-like media origin
// that serves playlists, segments, and keys. The hifi-api's /trackManifests/
// returns attributes.uri pointing at the media server's root playlist.
func hifiMediaServer(t *testing.T, playlistBody string) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/trackManifests/":
			mediaURL := srv.URL + "/media/playlist.m3u8"
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"version":"2.10","data":{"data":{"attributes":{"trackPresentation":"FULL","uri":"` + mediaURL + `","formats":["FLAC"]}}}}`))
		case r.URL.Path == "/media/playlist.m3u8":
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = w.Write([]byte(playlistBody))
		case strings.HasPrefix(r.URL.Path, "/media/seg"):
			w.Header().Set("Content-Type", "audio/mp4")
			_, _ = w.Write([]byte(r.URL.Path[len("/media/"):])) // payload = "seg1.aac" etc.
		case r.URL.Path == "/media/keys/1.key":
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write(aesKeyFixture)
		case r.URL.Path == "/track/":
			http.Error(w, "should not fallback", http.StatusInternalServerError)
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	return srv
}

var aesKeyFixture = []byte("0123456789abcdef") // 16 bytes

// allowLoopbackMedia swaps the package-level media policy + host allowlist so
// the client can fetch playlists/segments/keys from httptest's loopback
// origin. It returns an HTTP client whose dialer permits loopback (to assign
// onto Client.stream) and a restore func.
func allowLoopbackMedia() (*http.Client, func()) {
	prevPolicy := mediaDownloadPolicy
	prevHost := mediaHostAllowed
	mediaDownloadPolicy = httpx.DownloadPolicy{AllowLoopback: true}
	mediaHostAllowed = func(string) bool { return true }
	client := httpx.NewDownloadClient(httpx.DownloadPolicy{AllowLoopback: true}, net.DefaultResolver)
	return client, func() {
		mediaDownloadPolicy = prevPolicy
		mediaHostAllowed = prevHost
	}
}

func TestFileResponseConcatenatesSegments(t *testing.T) {
	streamClient, restore := allowLoopbackMedia()
	defer restore()

	playlist := strings.Join([]string{
		"#EXTM3U",
		"#EXT-X-VERSION:3",
		"#EXT-X-TARGETDURATION:10",
		"#EXTINF:10.0,",
		"seg1.aac",
		"#EXTINF:10.0,",
		"seg2.aac",
		"#EXT-X-ENDLIST",
		"",
	}, "\n")
	srv := hifiMediaServer(t, playlist)
	defer srv.Close()

	c := NewClient(Config{HifiAPIURL: srv.URL, Quality: "LOSSLESS"})
	c.stream = streamClient
	resp, err := c.FileResponse(context.Background(), "123", nil)
	if err != nil {
		t.Fatalf("FileResponse returned error: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "audio/mp4" {
		t.Fatalf("Content-Type = %q, want audio/mp4", ct)
	}
	if ar := resp.Header.Get("Accept-Ranges"); ar != "none" {
		t.Fatalf("Accept-Ranges = %q, want none", ar)
	}
	body, _ := io.ReadAll(resp.Body)
	want := "seg1.aacseg2.aac"
	if string(body) != want {
		t.Fatalf("body = %q, want %q", string(body), want)
	}
}

func TestFileResponseMasterPlaylistPicksHighestBandwidth(t *testing.T) {
	streamClient, restore := allowLoopbackMedia()
	defer restore()

	// Override: serve a master playlist at /media/playlist.m3u8 whose
	// variants point at /media/low.m3u8 and /media/high.m3u8.
	master := strings.Join([]string{
		"#EXTM3U",
		"#EXT-X-STREAM-INF:BANDWIDTH=1000",
		"low.m3u8",
		"#EXT-X-STREAM-INF:BANDWIDTH=5000",
		"high.m3u8",
		"",
	}, "\n")
	lowMedia := strings.Join([]string{"#EXTM3U", "#EXTINF:1.0,", "lowseg.aac", "#EXT-X-ENDLIST", ""}, "\n")
	highMedia := strings.Join([]string{"#EXTM3U", "#EXTINF:1.0,", "highseg.aac", "#EXT-X-ENDLIST", ""}, "\n")

	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/trackManifests/":
			mediaURL := srv.URL + "/media/playlist.m3u8"
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"version":"2.10","data":{"data":{"attributes":{"trackPresentation":"FULL","uri":"` + mediaURL + `"}}}}`))
		case r.URL.Path == "/media/playlist.m3u8":
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = w.Write([]byte(master))
		case r.URL.Path == "/media/low.m3u8":
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = w.Write([]byte(lowMedia))
		case r.URL.Path == "/media/high.m3u8":
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = w.Write([]byte(highMedia))
		case strings.HasPrefix(r.URL.Path, "/media/"):
			w.Header().Set("Content-Type", "audio/mp4")
			_, _ = w.Write([]byte(r.URL.Path[len("/media/"):]))
		case r.URL.Path == "/track/":
			http.Error(w, "no fallback", http.StatusInternalServerError)
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	c := NewClient(Config{HifiAPIURL: srv.URL, Quality: "LOSSLESS"})
	c.stream = streamClient
	resp, err := c.FileResponse(context.Background(), "123", nil)
	if err != nil {
		t.Fatalf("FileResponse returned error: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "highseg.aac" {
		t.Fatalf("body = %q, want highseg.aac (highest bandwidth)", string(body))
	}
}

func TestFileResponseAES128Decrypts(t *testing.T) {
	streamClient, restore := allowLoopbackMedia()
	defer restore()

	key := aesKeyFixture
	iv, _ := hex.DecodeString("00000000000000000000000000000001")
	plain1 := []byte("the quick brown fox jumps over the lazy dog") // 43 bytes
	plain2 := []byte("final segment!")                               // 14 bytes

	enc1 := encryptAES128CBC(plain1, key, iv)
	enc2 := encryptAES128CBC(plain2, key, iv)

	playlist := strings.Join([]string{
		"#EXTM3U",
		"#EXT-X-VERSION:3",
		`#EXT-X-KEY:METHOD=AES-128,URI="keys/1.key",IV=0x` + hex.EncodeToString(iv),
		"#EXTINF:10.0,",
		"seg1.aac",
		"#EXTINF:10.0,",
		"seg2.aac",
		"#EXT-X-ENDLIST",
		"",
	}, "\n")

	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/trackManifests/":
			mediaURL := srv.URL + "/media/playlist.m3u8"
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"version":"2.10","data":{"data":{"attributes":{"trackPresentation":"FULL","uri":"` + mediaURL + `"}}}}`))
		case r.URL.Path == "/media/playlist.m3u8":
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = w.Write([]byte(playlist))
		case r.URL.Path == "/media/seg1.aac":
			w.Header().Set("Content-Type", "audio/mp4")
			_, _ = w.Write(enc1)
		case r.URL.Path == "/media/seg2.aac":
			w.Header().Set("Content-Type", "audio/mp4")
			_, _ = w.Write(enc2)
		case r.URL.Path == "/media/keys/1.key":
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write(key)
		case r.URL.Path == "/track/":
			http.Error(w, "no fallback", http.StatusInternalServerError)
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	c := NewClient(Config{HifiAPIURL: srv.URL, Quality: "LOSSLESS"})
	c.stream = streamClient
	resp, err := c.FileResponse(context.Background(), "123", nil)
	if err != nil {
		t.Fatalf("FileResponse returned error: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	want := append(append([]byte{}, plain1...), plain2...)
	if !bytes.Equal(body, want) {
		t.Fatalf("decrypted body = %q, want %q", string(body), string(want))
	}
}

func TestFileResponsePreviewRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/trackManifests/":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"version":"2.10","data":{"data":{"attributes":{"trackPresentation":"PREVIEW","previewReason":"no subscription"}}}}`))
		case "/track/":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"version":"2.10","data":{"assetPresentation":"PREVIEW","manifest":""}}`))
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	c := NewClient(Config{HifiAPIURL: srv.URL, Quality: "LOSSLESS"})
	_, err := c.FileResponse(context.Background(), "123", nil)
	if !errors.Is(err, ErrPreviewManifest) {
		t.Fatalf("err = %v, want ErrPreviewManifest", err)
	}
}

func encryptAES128CBC(plain, key, iv []byte) []byte {
	block, _ := aes.NewCipher(key)
	pad := 16 - len(plain)%16
	padded := append(append([]byte{}, plain...), bytes.Repeat([]byte{byte(pad)}, pad)...)
	out := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(out, padded)
	return out
}

// TestFileResponseFMP4InitSegment verifies the #EXT-X-MAP init section is
// fetched and prepended so the concatenated file has valid ftyp/moov boxes.
// Without this, downloaded .m4a files are orphaned moof/mdat fragments and
// are unplayable.
func TestFileResponseFMP4InitSegment(t *testing.T) {
	streamClient, restore := allowLoopbackMedia()
	defer restore()

	initBytes := []byte{0x00, 0x00, 0x00, 0x20, 'f', 't', 'y', 'p'} // ftyp box header
	seg1 := []byte("moofmdat-segment-1-payload")
	seg2 := []byte("moofmdat-segment-2-payload")

	playlist := strings.Join([]string{
		"#EXTM3U",
		"#EXT-X-VERSION:6",
		"#EXT-X-TARGETDURATION:10",
		`#EXT-X-MAP:URI="init.mp4"`,
		"#EXTINF:10.0,",
		"seg1.m4s",
		"#EXTINF:10.0,",
		"seg2.m4s",
		"#EXT-X-ENDLIST",
		"",
	}, "\n")

	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/trackManifests/":
			mediaURL := srv.URL + "/media/playlist.m3u8"
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"version":"2.10","data":{"data":{"attributes":{"trackPresentation":"FULL","uri":"` + mediaURL + `"}}}}`))
		case r.URL.Path == "/media/playlist.m3u8":
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = w.Write([]byte(playlist))
		case r.URL.Path == "/media/init.mp4":
			w.Header().Set("Content-Type", "audio/mp4")
			_, _ = w.Write(initBytes)
		case r.URL.Path == "/media/seg1.m4s":
			w.Header().Set("Content-Type", "audio/mp4")
			_, _ = w.Write(seg1)
		case r.URL.Path == "/media/seg2.m4s":
			w.Header().Set("Content-Type", "audio/mp4")
			_, _ = w.Write(seg2)
		case r.URL.Path == "/track/":
			http.Error(w, "no fallback", http.StatusInternalServerError)
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	c := NewClient(Config{HifiAPIURL: srv.URL, Quality: "LOSSLESS"})
	c.stream = streamClient
	resp, err := c.FileResponse(context.Background(), "123", nil)
	if err != nil {
		t.Fatalf("FileResponse returned error: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	want := append(append(append([]byte{}, initBytes...), seg1...), seg2...)
	if !bytes.Equal(body, want) {
		t.Fatalf("body = %q, want init+seg1+seg2 = %q", string(body), string(want))
	}
	// The init bytes must come first — a corrupted file (missing init) would
	// start with "moof" instead of the ftyp header.
	if !bytes.HasPrefix(body, initBytes) {
		t.Fatalf("body does not start with init segment (ftyp)")
	}
}
