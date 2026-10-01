package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/httpapi/handlers"
	"github.com/githubesson/lumen/internal/httpapi/middleware"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/mediaembed"
	"github.com/githubesson/lumen/internal/storage"
)

// A downloaded local track carries the library's metadata and album cover,
// while playback and HEAD probes get the file as stored.
func TestLocalDownloadCarriesLibraryMetadata(t *testing.T) {
	if !mediaembed.Available() {
		t.Skip("ffmpeg not available")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe not available")
	}
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	root := t.TempDir()
	sfx := uuid.NewString()[:8]
	t.Cleanup(func() {
		bg := context.Background()
		pool.Exec(bg, `DELETE FROM tracks WHERE starts_with(file_path, $1)`, root)
		pool.Exec(bg, `DELETE FROM albums WHERE title LIKE $1`, "%"+sfx)
		pool.Exec(bg, `DELETE FROM artists WHERE name LIKE $1`, "%"+sfx)
	})
	svc := &ingest.Service{
		DB: pool, Library: lib, Storage: storage.NewLocal(root), MusicRoot: root,
		Roots:  func(context.Context) []string { return []string{root} },
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	// The file as tagged on disk, with its own (red) picture.
	path := filepath.Join(root, "song.flac")
	pic := filepath.Join(t.TempDir(), "file-art.png")
	if out, err := exec.Command("ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi",
		"-i", "color=c=red:s=16x16", "-frames:v", "1", pic).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg picture: %v (%s)", err, out)
	}
	if out, err := exec.Command("ffmpeg", "-nostdin", "-v", "error",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-i", pic,
		"-map", "0:a", "-map", "1:v", "-c:a", "flac", "-c:v", "copy",
		"-disposition:v:0", "attached_pic",
		"-metadata", "title=File Title", "-metadata", "artist=File Artist",
		"-metadata", "album=File Album "+sfx, "-metadata", "genre=Rock", path).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v (%s)", err, out)
	}
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	out := svc.IngestFile(ctx, path)
	if out.Err != nil || out.TrackID == uuid.Nil {
		t.Fatalf("ingest = %+v", out)
	}

	// What the library says now.
	title, album, albumArtist := "Library Title", "Library Album "+sfx, "Main "+sfx
	artists := []string{"Main " + sfx, "Guest " + sfx}
	year, trackNo := 2001, 4
	if err := lib.UpdateTrack(ctx, out.TrackID, library.TrackPatch{
		Title: &title, Artists: &artists, AlbumTitle: &album, AlbumArtist: &albumArtist, Year: &year, TrackNo: &trackNo,
	}); err != nil {
		t.Fatal(err)
	}
	var albumID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT album_id FROM tracks WHERE id = $1`, out.TrackID).Scan(&albumID); err != nil {
		t.Fatal(err)
	}
	img := image.NewRGBA(image.Rect(0, 0, 32, 32))
	for i := range img.Pix {
		img.Pix[i] = 0xff
	}
	img.Set(0, 0, color.RGBA{B: 0xff, A: 0xff})
	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, img); err != nil {
		t.Fatal(err)
	}
	key, err := svc.StoreCoverImage(ctx, pngBuf.Bytes(), "image/png")
	if err != nil {
		t.Fatal(err)
	}
	if err := lib.SetAlbumCover(ctx, albumID, key); err != nil {
		t.Fatal(err)
	}

	viewer := redteamUser(t, ctx, pool)
	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	token, _, err := sessions.Create(ctx, viewer, httptest.NewRequest(http.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Use(middleware.Authenticate(sessions), middleware.RequireUser)
	h := &handlers.Tracks{Library: lib, Storage: svc.Storage, Ingest: svc}
	router.Get("/tracks/{id}/stream", h.Stream)
	router.Head("/tracks/{id}/stream", h.Stream)
	fetch := func(method, query string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/tracks/"+out.TrackID.String()+"/stream"+query, nil)
		req.AddCookie(&http.Cookie{Name: "session", Value: token})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s %s = %d %s", method, query, rec.Code, rec.Body)
		}
		return rec
	}

	// Download: the library's metadata and cover.
	rec := fetch(http.MethodGet, "?download=1")
	if ct := rec.Header().Get("Content-Type"); ct != "audio/flac" {
		t.Fatalf("content type %q", ct)
	}
	got := filepath.Join(t.TempDir(), "download.flac")
	if err := os.WriteFile(got, rec.Body.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	probeOut, err := exec.Command("ffprobe", "-v", "error", "-print_format", "json",
		"-show_format", "-show_streams", got).Output()
	if err != nil {
		t.Fatal(err)
	}
	var info struct {
		Format struct {
			Tags map[string]string `json:"tags"`
		} `json:"format"`
		Streams []struct {
			CodecName   string         `json:"codec_name"`
			Disposition map[string]int `json:"disposition"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(probeOut, &info); err != nil {
		t.Fatal(err)
	}
	tags := map[string]string{}
	for k, v := range info.Format.Tags {
		tags[strings.ToLower(k)] = v
	}
	for k, want := range map[string]string{
		"title": title, "artist": artists[0] + "; " + artists[1], "album": album,
		"album_artist": albumArtist, "date": "2001", "track": "4", "genre": "Rock",
	} {
		if tags[k] != want {
			t.Errorf("tag %s = %q, want %q (all: %v)", k, tags[k], want, tags)
		}
	}
	var pics []string
	for _, s := range info.Streams {
		if s.Disposition["attached_pic"] == 1 {
			pics = append(pics, s.CodecName)
		}
	}
	if len(pics) != 1 || pics[0] != "mjpeg" {
		t.Errorf("pictures %v; want the library's (JPEG) cover in place of the file's PNG", pics)
	}

	// Same audio: a downloaded copy uploaded back dedups into the track.
	wantSHA, err := ingest.AudioSHA256(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if gotSHA, err := ingest.AudioSHA256(ctx, got); err != nil || gotSHA != wantSHA {
		t.Fatalf("download audio hash %s (%v), want the original's %s", gotSHA, err, wantSHA)
	}

	// Playback and HEAD probes: the file as stored.
	if body := fetch(http.MethodGet, "").Body.Bytes(); !bytes.Equal(body, original) {
		t.Fatal("playback didn't serve the file as stored")
	}
	if n := fetch(http.MethodHead, "?download=1").Header().Get("Content-Length"); n != strings.TrimSpace(itoa(len(original))) {
		t.Fatalf("HEAD Content-Length %s; want the stored file's %d (no remux)", n, len(original))
	}
	if after, _ := os.ReadFile(path); !bytes.Equal(after, original) {
		t.Fatal("the library file was modified")
	}
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}
