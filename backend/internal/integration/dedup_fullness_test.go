package integration

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/httpapi/handlers"
	"github.com/githubesson/lumen/internal/httpapi/middleware"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/storage"
)

// writeFLAC writes a minimal FLAC whose audio payload is audio, tagged with
// Vorbis comments ("KEY=value") when any are given. Files sharing audio
// dedup into one track whatever their tags.
func writeFLAC(t *testing.T, path, audio string, comments ...string) {
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
	data := append([]byte("fLaC"), block(0, len(comments) == 0, streaminfo)...)
	if len(comments) > 0 {
		vc := le(nil, 4)
		vc = append(vc, "test"...)
		vc = le(vc, uint32(len(comments)))
		for _, c := range comments {
			vc = le(vc, uint32(len(c)))
			vc = append(vc, c...)
		}
		data = append(data, block(4, true, vc)...)
	}
	data = append(data, audio...)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

type trackSnapshot struct {
	Title, FilePath, Album string
	Artists                []string
	Aliases                []string // "path|title|artists|album"
}

func snapshotTrack(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id uuid.UUID) trackSnapshot {
	t.Helper()
	var s trackSnapshot
	if err := pool.QueryRow(ctx, `
		SELECT t.title, t.file_path, COALESCE(a.title, ''),
		       COALESCE((SELECT ARRAY_AGG(ar.name || ':' || ta.role ORDER BY ta.position)
		                 FROM track_artists ta JOIN artists ar ON ar.id = ta.artist_id
		                 WHERE ta.track_id = t.id), '{}'),
		       COALESCE((SELECT ARRAY_AGG(al.file_path || '|' || COALESCE(al.title, '') || '|' ||
		                                  COALESCE(al.artist_names, '') || '|' || COALESCE(al.album_title, '')
		                                  ORDER BY al.id)
		                 FROM track_aliases al WHERE al.track_id = t.id), '{}')
		FROM tracks t LEFT JOIN albums a ON a.id = t.album_id
		WHERE t.id = $1`, id).Scan(&s.Title, &s.FilePath, &s.Album, &s.Artists, &s.Aliases); err != nil {
		t.Fatal(err)
	}
	return s
}

// An untagged original ingested first used to keep the track forever, with
// the tagged copy's metadata only searchable. The fuller copy now takes over.
func TestDuplicateWithFullerMetadataBecomesCanonical(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	primary, extra := t.TempDir(), t.TempDir()
	sfx := uuid.NewString()[:8]
	album, artistA, artistB := "Fullness "+sfx, "Artist A "+sfx, "Artist B "+sfx
	t.Cleanup(func() {
		bg := context.Background()
		pool.Exec(bg, `DELETE FROM tracks WHERE starts_with(file_path,$1) OR starts_with(file_path,$2)`, primary, extra)
		pool.Exec(bg, `DELETE FROM albums a WHERE title IN ($1,'Others') AND NOT EXISTS(SELECT 1 FROM tracks t WHERE t.album_id=a.id)`, album)
		pool.Exec(bg, `DELETE FROM artists WHERE name IN ($1,$2)`, artistA, artistB)
	})
	svc := &ingest.Service{
		DB: pool, Library: lib, Storage: storage.NewLocal(primary), MusicRoot: primary,
		Roots:  func(context.Context) []string { return []string{primary, extra} },
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	ingestOK := func(path string, owner *uuid.UUID) ingest.Outcome {
		t.Helper()
		out := svc.IngestFileAs(ctx, path, owner)
		if out.Err != nil {
			t.Fatalf("ingest %s: %v", path, out.Err)
		}
		return out
	}
	audio := "fullness-audio-" + sfx
	tags := []string{"TITLE=Blue Hunnids", "ARTIST=" + artistA + " & " + artistB, "ALBUM=" + album}

	og := filepath.Join(primary, "Freestyle.flac")
	writeFLAC(t, og, audio)
	first := ingestOK(og, nil)
	if !first.Inserted {
		t.Fatalf("first ingest = %+v", first)
	}
	bare := trackSnapshot{Title: "Freestyle", FilePath: og, Album: "Others", Artists: []string{}, Aliases: []string{}}
	if got := snapshotTrack(t, ctx, pool, first.TrackID); !reflect.DeepEqual(got, bare) {
		t.Fatalf("untagged track = %+v", got)
	}

	// A personal upload never rewrites the global track it dedups into.
	user := redteamUser(t, ctx, pool)
	upload := filepath.Join(primary, ".users", user.String(), "upload.flac")
	writeFLAC(t, upload, audio, tags...)
	if out := ingestOK(upload, &user); out.TrackID != first.TrackID || out.Inserted {
		t.Fatalf("personal upload = %+v", out)
	}
	if got := snapshotTrack(t, ctx, pool, first.TrackID); !reflect.DeepEqual(got, bare) {
		t.Fatalf("personal upload changed the global track: %+v", got)
	}

	tagged := filepath.Join(primary, "leaks", "Blue Hunnids.flac")
	writeFLAC(t, tagged, audio, tags...)
	if out := ingestOK(tagged, nil); out.TrackID != first.TrackID || out.Inserted {
		t.Fatalf("tagged ingest = %+v", out)
	}
	want := trackSnapshot{
		Title: "Blue Hunnids", FilePath: tagged, Album: album,
		Artists: []string{artistA + ":primary", artistB + ":featured"},
		Aliases: []string{og + "|Freestyle||Others"},
	}
	if got := snapshotTrack(t, ctx, pool, first.TrackID); !reflect.DeepEqual(got, want) {
		t.Fatalf("after tagged copy:\n got %+v\nwant %+v", got, want)
	}
	if _, err := os.Stat(og); !os.IsNotExist(err) {
		t.Fatalf("replaced original still on disk: %v", err)
	}
	if _, err := os.Stat(tagged); err != nil {
		t.Fatalf("adopted copy removed: %v", err)
	}
	var fingerprinted string
	if err := pool.QueryRow(ctx, `SELECT COALESCE(ingested_file_path,'') FROM tracks WHERE id=$1`, first.TrackID).Scan(&fingerprinted); err != nil || fingerprinted != tagged {
		t.Fatalf("fingerprint path = %q, %v", fingerprinted, err)
	}
	rows, err := lib.ListTracks(ctx, library.ListTracksParams{ViewerID: user, Query: "Freestyle", Limit: 5})
	if err != nil || len(rows) != 1 || rows[0].Title != "Blue Hunnids" || rows[0].Aka != "Freestyle" {
		t.Fatalf("search by the old title = %+v, %v", rows, err)
	}

	// Copies that are no fuller only add aliases, and stay on disk outside
	// the primary root.
	bareCopy := filepath.Join(extra, "Freestyle (1).flac")
	writeFLAC(t, bareCopy, audio)
	partial := filepath.Join(extra, "partial.flac")
	writeFLAC(t, partial, audio, "TITLE=Other Title", "ARTIST="+artistB)
	ingestOK(bareCopy, nil)
	ingestOK(partial, nil)
	want.Aliases = append(want.Aliases, bareCopy+"|Freestyle (1)||Others", partial+"|Other Title|"+artistB+"|")
	if got := snapshotTrack(t, ctx, pool, first.TrackID); !reflect.DeepEqual(got, want) {
		t.Fatalf("after less full copies:\n got %+v\nwant %+v", got, want)
	}
	for _, p := range []string{bareCopy, partial} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("%s: %v", p, err)
		}
	}

	// The track info dialog lists every version by file name, never by path.
	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	token, _, err := sessions.Create(ctx, user, httptest.NewRequest(http.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Use(middleware.Authenticate(sessions), middleware.RequireUser)
	router.Get("/tracks/{id}", (&handlers.Tracks{Library: lib, Ingest: svc}).Get)
	req := httptest.NewRequest(http.MethodGet, "/tracks/"+first.TrackID.String(), nil)
	req.AddCookie(&http.Cookie{Name: "session", Value: token})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	var detail struct {
		FileName string `json:"file_name"`
		Aliases  []map[string]string
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &detail); rec.Code != http.StatusOK || err != nil {
		t.Fatalf("GET track = %d %s: %v", rec.Code, rec.Body, err)
	}
	wantAliases := []map[string]string{
		{"file_name": "Freestyle.flac", "title": "Freestyle", "album_title": "Others"},
		{"file_name": "Freestyle (1).flac", "title": "Freestyle (1)", "album_title": "Others"},
		{"file_name": "partial.flac", "title": "Other Title", "artist_names": artistB},
	}
	if detail.FileName != "Blue Hunnids.flac" || !reflect.DeepEqual(detail.Aliases, wantAliases) {
		t.Fatalf("GET track versions = %q %+v", detail.FileName, detail.Aliases)
	}
	if strings.Contains(rec.Body.String(), primary) || strings.Contains(rec.Body.String(), extra) {
		t.Fatalf("GET track leaks a server path: %s", rec.Body)
	}
}

// Tracks merged before ingest compared copies are repaired from their alias
// rows, whose files ingest usually removed.
func TestAdoptFullerAliasesRepairsEarlierMerges(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	sfx := uuid.NewString()[:8]
	albumTitle, artistA, artistB, stranger := "Legacy "+sfx, "Legacy A "+sfx, "Legacy B "+sfx, "Stranger "+sfx
	t.Cleanup(func() {
		bg := context.Background()
		pool.Exec(bg, `DELETE FROM albums a WHERE title IN ($1,'Others') AND NOT EXISTS(SELECT 1 FROM tracks t WHERE t.album_id=a.id)`, albumTitle)
		pool.Exec(bg, `DELETE FROM artists WHERE name IN ($1,$2,$3)`, artistA, artistB, stranger)
	})
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	others, err := library.UpsertAlbum(ctx, tx, library.CatchAllAlbum, nil, 0, false, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	// The album ingest created when it read the tagged copy, by its album
	// artist; a same-titled album by someone else must not be picked.
	byB, err := library.UpsertArtist(ctx, tx, artistB)
	if err != nil {
		t.Fatal(err)
	}
	album, err := library.UpsertAlbum(ctx, tx, albumTitle, &byB, 2020, false, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	byStranger, err := library.UpsertArtist(ctx, tx, stranger)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := library.UpsertAlbum(ctx, tx, albumTitle, &byStranger, 0, false, "", nil); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	merged := redteamTrack(t, ctx, pool, nil, &others)
	full := redteamTrack(t, ctx, pool, nil, &album)
	var mergedPath, mergedTitle string
	if err := pool.QueryRow(ctx, `SELECT file_path, title FROM tracks WHERE id=$1`, merged).Scan(&mergedPath, &mergedTitle); err != nil {
		t.Fatal(err)
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO track_aliases(track_id,file_path,title,album_title) VALUES($1,'/gone/bare.flac','Bare','Others')`, merged)
	exec(`INSERT INTO track_aliases(track_id,file_path,title,artist_names,album_title) VALUES($1,'/gone/tagged.flac','Tagged',$2,$3)`,
		merged, artistA+", "+artistB, albumTitle)
	// A track that already has artists and an album keeps them.
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := library.ReplaceTrackArtists(ctx, tx, full, []string{artistB}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO track_aliases(track_id,file_path,title,artist_names,album_title) VALUES($1,'/gone/other.flac','Other',$2,$3)`,
		full, artistA, albumTitle)
	fullBefore := snapshotTrack(t, ctx, pool, full)

	n, err := lib.AdoptFullerAliases(ctx)
	if err != nil || n < 1 {
		t.Fatalf("AdoptFullerAliases = %d, %v", n, err)
	}
	want := trackSnapshot{
		Title: "Tagged", FilePath: mergedPath, Album: albumTitle,
		Artists: []string{artistA + ":primary", artistB + ":featured"},
		Aliases: []string{"/gone/bare.flac|Bare||Others", "/gone/tagged.flac|" + mergedTitle + "||Others"},
	}
	if got := snapshotTrack(t, ctx, pool, merged); !reflect.DeepEqual(got, want) {
		t.Fatalf("repaired track:\n got %+v\nwant %+v", got, want)
	}
	var gotAlbum uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT album_id FROM tracks WHERE id=$1`, merged).Scan(&gotAlbum); err != nil || gotAlbum != album {
		t.Fatalf("album = %s, want %s: %v", gotAlbum, album, err)
	}
	if got := snapshotTrack(t, ctx, pool, full); !reflect.DeepEqual(got, fullBefore) {
		t.Fatalf("full track changed:\n got %+v\nwant %+v", got, fullBefore)
	}
	if n, err := lib.AdoptFullerAliases(ctx); err != nil || n != 0 {
		t.Fatalf("second pass = %d, %v", n, err)
	}
}
