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

type trackVersions struct {
	FileName   string              `json:"file_name"`
	Aliases    []map[string]string `json:"aliases"`
	AliasCount int                 `json:"alias_count"`
}

// getTrackVersions fetches GET /tracks/{id} as viewer through the real
// handler, returning its versions and the raw body.
func getTrackVersions(t *testing.T, ctx context.Context, pool *pgxpool.Pool, lib *library.Store, viewer, id uuid.UUID) (trackVersions, string) {
	t.Helper()
	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	token, _, err := sessions.Create(ctx, viewer, httptest.NewRequest(http.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Use(middleware.Authenticate(sessions), middleware.RequireUser)
	router.Get("/tracks/{id}", (&handlers.Tracks{Library: lib}).Get)
	req := httptest.NewRequest(http.MethodGet, "/tracks/"+id.String(), nil)
	req.AddCookie(&http.Cookie{Name: "session", Value: token})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	var v trackVersions
	if err := json.Unmarshal(rec.Body.Bytes(), &v); rec.Code != http.StatusOK || err != nil {
		t.Fatalf("GET track = %d %s: %v", rec.Code, rec.Body, err)
	}
	return v, rec.Body.String()
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
	album, artistA, artistB, producer := "Fullness "+sfx, "Artist A "+sfx, "Artist B "+sfx, "Producer "+sfx
	t.Cleanup(func() {
		bg := context.Background()
		pool.Exec(bg, `DELETE FROM tracks WHERE starts_with(file_path,$1) OR starts_with(file_path,$2)`, primary, extra)
		pool.Exec(bg, `DELETE FROM albums a WHERE title IN ($1,'Others') AND NOT EXISTS(SELECT 1 FROM tracks t WHERE t.album_id=a.id)`, album)
		pool.Exec(bg, `DELETE FROM artists WHERE name IN ($1,$2,$3)`, artistA, artistB, producer)
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
	writeFLAC(t, og, audio, "DATE=2021", "GENRE=Leak", "TRACKNUMBER=3")
	first := ingestOK(og, nil)
	if !first.Inserted {
		t.Fatalf("first ingest = %+v", first)
	}
	bare := trackSnapshot{Title: "Freestyle", FilePath: og, Album: "Others", Artists: []string{}, Aliases: []string{}}
	if got := snapshotTrack(t, ctx, pool, first.TrackID); !reflect.DeepEqual(got, bare) {
		t.Fatalf("untagged track = %+v", got)
	}
	var ogTrackNo int
	if err := pool.QueryRow(ctx, `SELECT COALESCE(track_no, 0) FROM tracks WHERE id=$1`, first.TrackID).Scan(&ogTrackNo); err != nil || ogTrackNo != 3 {
		t.Fatalf("original track_no = %d, %v", ogTrackNo, err)
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
	// Tags the tagged copy lacks keep the original's values, except the
	// track number, which belonged to the album it no longer is on.
	var year, trackNo *int
	var genre *string
	if err := pool.QueryRow(ctx, `SELECT year, genre, track_no FROM tracks WHERE id=$1`, first.TrackID).Scan(&year, &genre, &trackNo); err != nil ||
		year == nil || *year != 2021 || genre == nil || *genre != "Leak" || trackNo != nil {
		t.Fatalf("kept tags: year=%v genre=%v track_no=%v, %v", year, genre, trackNo, err)
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
	// Aliases keep performers only: a composer would read as one.
	writeFLAC(t, partial, audio, "TITLE=Other Title", "ARTIST="+artistB, "COMPOSER="+producer)
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
	detail, body := getTrackVersions(t, ctx, pool, lib, user, first.TrackID)
	wantAliases := []map[string]string{
		{"file_name": "Freestyle.flac", "title": "Freestyle", "album_title": "Others"},
		{"file_name": "Freestyle (1).flac", "title": "Freestyle (1)", "album_title": "Others"},
		{"file_name": "partial.flac", "title": "Other Title", "artist_names": artistB},
	}
	if detail.FileName != "Blue Hunnids.flac" || detail.AliasCount != 3 || !reflect.DeepEqual(detail.Aliases, wantAliases) {
		t.Fatalf("GET track versions = %+v", detail)
	}
	if strings.Contains(body, primary) || strings.Contains(body, extra) {
		t.Fatalf("GET track leaks a server path: %s", body)
	}

	// Metadata edited on purpose isn't replaced by a fuller copy's tags.
	handFixed := filepath.Join(primary, "Hand Fixed.flac")
	writeFLAC(t, handFixed, audio+"-edited")
	editedID := ingestOK(handFixed, nil).TrackID
	fixedTitle := "Hand fixed"
	if err := lib.UpdateTrack(ctx, editedID, library.TrackPatch{Title: &fixedTitle}); err != nil {
		t.Fatal(err)
	}
	editedCopy := filepath.Join(primary, "edited copy.flac")
	writeFLAC(t, editedCopy, audio+"-edited", tags...)
	ingestOK(editedCopy, nil)
	wantEdited := trackSnapshot{
		Title: fixedTitle, FilePath: handFixed, Album: "Others", Artists: []string{},
		Aliases: []string{editedCopy + "|Blue Hunnids|" + artistA + ", " + artistB + "|" + album},
	}
	if got := snapshotTrack(t, ctx, pool, editedID); !reflect.DeepEqual(got, wantEdited) {
		t.Fatalf("edited track:\n got %+v\nwant %+v", got, wantEdited)
	}

	// A real album called Others (it has an album artist) beats the catch-all,
	// even on a copy without track artists.
	othersAudio := audio + "-others"
	othersBare := filepath.Join(primary, "others bare.flac")
	writeFLAC(t, othersBare, othersAudio)
	othersID := ingestOK(othersBare, nil).TrackID
	othersTagged := filepath.Join(primary, "others tagged.flac")
	writeFLAC(t, othersTagged, othersAudio, "TITLE=On Others", "ALBUM="+library.CatchAllAlbum, "ALBUMARTIST="+artistB)
	ingestOK(othersTagged, nil)
	var othersTitle, othersAlbumArtist string
	if err := pool.QueryRow(ctx, `
		SELECT t.title, COALESCE(ar.name, '') FROM tracks t
		JOIN albums a ON a.id = t.album_id LEFT JOIN artists ar ON ar.id = a.album_artist_id
		WHERE t.id = $1`, othersID).Scan(&othersTitle, &othersAlbumArtist); err != nil ||
		othersTitle != "On Others" || othersAlbumArtist != artistB {
		t.Fatalf("real Others copy = %q by %q, %v", othersTitle, othersAlbumArtist, err)
	}

	// A personal upload's edit goes when the global file takes the row over,
	// so a fuller global copy can still replace it.
	promoAudio := audio + "-promoted"
	upload2 := filepath.Join(primary, ".users", user.String(), "promo.flac")
	writeFLAC(t, upload2, promoAudio)
	personal := ingestOK(upload2, &user)
	personalTitle := "Uploader title"
	if err := lib.UpdateTrack(ctx, personal.TrackID, library.TrackPatch{Title: &personalTitle}); err != nil {
		t.Fatal(err)
	}
	globalBare := filepath.Join(primary, "promo.flac")
	writeFLAC(t, globalBare, promoAudio)
	if out := ingestOK(globalBare, nil); out.TrackID != personal.TrackID || !out.Inserted {
		t.Fatalf("promotion = %+v", out)
	}
	globalTagged := filepath.Join(primary, "promo tagged.flac")
	writeFLAC(t, globalTagged, promoAudio, tags...)
	ingestOK(globalTagged, nil)
	var promotedTitle, promotedPath string
	if err := pool.QueryRow(ctx, `SELECT title, file_path FROM tracks WHERE id=$1`, personal.TrackID).Scan(&promotedTitle, &promotedPath); err != nil ||
		promotedTitle != "Blue Hunnids" || promotedPath != globalTagged {
		t.Fatalf("promoted track = %q at %q, %v", promotedTitle, promotedPath, err)
	}
}

// Tracks merged before ingest compared copies are repaired from their alias
// rows, whose files ingest usually removed.
func TestAdoptFullerAliasesRepairsEarlierMerges(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	sfx := uuid.NewString()[:8]
	albumTitle, artistA, artistB, stranger := "Legacy "+sfx, "Legacy A "+sfx, "Legacy B "+sfx, "Stranger "+sfx
	soloTitle, credited, producer := "Solo "+sfx, "Credited "+sfx, "Producer "+sfx
	guest, nobody := "Guest "+sfx, "Nobody "+sfx
	t.Cleanup(func() {
		bg := context.Background()
		pool.Exec(bg, `DELETE FROM albums a WHERE title IN ($1,$2,'Others') AND NOT EXISTS(SELECT 1 FROM tracks t WHERE t.album_id=a.id)`, albumTitle, soloTitle)
		pool.Exec(bg, `DELETE FROM artists WHERE name IN ($1,$2,$3,$4,$5,$6,$7)`, artistA, artistB, stranger, credited, producer, guest, nobody)
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
	// The only album with its title, credited to an album artist who isn't
	// among the alias's artists.
	byCredited, err := library.UpsertArtist(ctx, tx, credited)
	if err != nil {
		t.Fatal(err)
	}
	soloAlbum, err := library.UpsertAlbum(ctx, tx, soloTitle, &byCredited, 0, false, "", nil)
	if err != nil {
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
	exec(`INSERT INTO track_aliases(unranked,track_id,file_path,title,album_title) VALUES(TRUE,$1,'/gone/bare.flac','Bare','Others')`, merged)
	exec(`INSERT INTO track_aliases(unranked,track_id,file_path,title,artist_names,album_title) VALUES(TRUE,$1,'/gone/tagged.flac','Tagged',$2,$3)`,
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
	exec(`INSERT INTO track_aliases(unranked,track_id,file_path,title,artist_names,album_title) VALUES(TRUE,$1,'/gone/other.flac','Other',$2,$3)`,
		full, artistA, albumTitle)
	// Credited only as a composer elsewhere: an older alias listing them last
	// got them from a composer tag.
	var producerID uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO artists(name) VALUES($1) RETURNING id`, producer).Scan(&producerID); err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO track_artists(track_id,artist_id,role,position) VALUES($1,$2,'composer',1)`, full, producerID)
	produced := redteamTrack(t, ctx, pool, nil, &others)
	exec(`INSERT INTO track_aliases(unranked,track_id,file_path,title,artist_names) VALUES(TRUE,$1,'/gone/produced.flac','Produced',$2)`,
		produced, artistA+", "+producer)
	// Named in the alias's own title: a featured guest, credits or not.
	featuring := redteamTrack(t, ctx, pool, nil, &others)
	exec(`INSERT INTO track_aliases(unranked,track_id,file_path,title,artist_names) VALUES(TRUE,$1,'/gone/with.flac',$2,$3)`,
		featuring, "Song (with "+guest+")", artistA+", "+guest)
	// Nothing says whether the last name was a guest or a composer tag: left
	// for someone to resolve in the versions view.
	ambiguous := redteamTrack(t, ctx, pool, nil, &others)
	exec(`INSERT INTO track_aliases(unranked,track_id,file_path,title,artist_names) VALUES(TRUE,$1,'/gone/ambiguous.flac','Ambiguous',$2)`,
		ambiguous, artistA+", "+nobody)
	if _, err := pool.Exec(ctx, `INSERT INTO artists(name) VALUES($1)`, nobody); err != nil {
		t.Fatal(err)
	}
	ambiguousBefore := snapshotTrack(t, ctx, pool, ambiguous)
	// Just as full as that ambiguous alias but settled: the next one is tried.
	retry := redteamTrack(t, ctx, pool, nil, &others)
	exec(`INSERT INTO track_aliases(unranked,track_id,file_path,title,artist_names) VALUES(TRUE,$1,'/gone/retry-a.flac','Retry A',$2)`,
		retry, artistA+", "+nobody)
	exec(`INSERT INTO track_aliases(unranked,track_id,file_path,title,artist_names) VALUES(TRUE,$1,'/gone/retry-b.flac','Retry B',$2)`,
		retry, artistA+", "+artistB)
	// An album really called "Others" (it has an album artist) counts as one.
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	realOthers, err := library.UpsertAlbum(ctx, tx, library.CatchAllAlbum, &byB, 0, false, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	onOthers := redteamTrack(t, ctx, pool, nil, &realOthers)
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := library.ReplaceTrackArtists(ctx, tx, onOthers, []string{artistB}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO track_aliases(unranked,track_id,file_path,title,artist_names,album_title) VALUES(TRUE,$1,'/gone/on-others.flac','Elsewhere',$2,$3)`,
		onOthers, artistA, albumTitle)
	onOthersBefore := snapshotTrack(t, ctx, pool, onOthers)
	fullBefore := snapshotTrack(t, ctx, pool, full)
	solo := redteamTrack(t, ctx, pool, nil, &others)
	exec(`INSERT INTO track_aliases(unranked,track_id,file_path,title,artist_names,album_title) VALUES(TRUE,$1,'/gone/solo.flac','Solo',$2,$3)`,
		solo, artistA, soloTitle)
	// Metadata edited on purpose stays, fuller alias or not.
	edited := redteamTrack(t, ctx, pool, nil, &others)
	handFixed := "Hand fixed " + sfx
	if err := lib.UpdateTrack(ctx, edited, library.TrackPatch{Title: &handFixed}); err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO track_aliases(unranked,track_id,file_path,title,artist_names,album_title) VALUES(TRUE,$1,'/gone/edited.flac','Tagged',$2,$3)`,
		edited, artistA, albumTitle)
	editedBefore := snapshotTrack(t, ctx, pool, edited)
	// A tagged copy that arrived first, merged with an untagged one that only
	// named artists.
	partial := redteamTrack(t, ctx, pool, nil, &others)
	exec(`INSERT INTO track_aliases(unranked,track_id,file_path,title,artist_names) VALUES(TRUE,$1,'/gone/partial.flac','Partial',$2)`,
		partial, artistA)
	var partialPath, partialTitle string
	if err := pool.QueryRow(ctx, `SELECT file_path, title FROM tracks WHERE id=$1`, partial).Scan(&partialPath, &partialTitle); err != nil {
		t.Fatal(err)
	}

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
	if got := snapshotTrack(t, ctx, pool, produced).Artists; !reflect.DeepEqual(got, []string{artistA + ":primary", producer + ":composer"}) {
		t.Fatalf("produced credits = %v", got)
	}
	if got := snapshotTrack(t, ctx, pool, retry); got.Title != "Retry B" ||
		!reflect.DeepEqual(got.Artists, []string{artistA + ":primary", artistB + ":featured"}) {
		t.Fatalf("retried track = %+v", got)
	}
	if got := snapshotTrack(t, ctx, pool, featuring).Artists; !reflect.DeepEqual(got, []string{artistA + ":primary", guest + ":featured"}) {
		t.Fatalf("featuring credits = %v", got)
	}
	for id, before := range map[uuid.UUID]trackSnapshot{ambiguous: ambiguousBefore, onOthers: onOthersBefore} {
		if got := snapshotTrack(t, ctx, pool, id); !reflect.DeepEqual(got, before) {
			t.Fatalf("track changed:\n got %+v\nwant %+v", got, before)
		}
	}
	var soloGot uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT album_id FROM tracks WHERE id=$1`, solo).Scan(&soloGot); err != nil || soloGot != soloAlbum {
		t.Fatalf("solo album = %s, want the existing %s: %v", soloGot, soloAlbum, err)
	}
	if got := snapshotTrack(t, ctx, pool, edited); !reflect.DeepEqual(got, editedBefore) {
		t.Fatalf("edited track changed:\n got %+v\nwant %+v", got, editedBefore)
	}
	// Versions are named after the file their tags came from, so the
	// swapped pair trade file names.
	viewer := redteamUser(t, ctx, pool)
	versions, _ := getTrackVersions(t, ctx, pool, lib, viewer, merged)
	wantVersions := trackVersions{FileName: "tagged.flac", AliasCount: 2, Aliases: []map[string]string{
		{"file_name": filepath.Base(mergedPath), "title": mergedTitle, "album_title": "Others"},
		{"file_name": "bare.flac", "title": "Bare", "album_title": "Others"},
	}}
	if !reflect.DeepEqual(versions, wantVersions) {
		t.Fatalf("repaired versions:\n got %+v\nwant %+v", versions, wantVersions)
	}

	// The repair runs once: a fuller alias recorded later (compared at
	// ingest) doesn't trigger it again.
	late := redteamTrack(t, ctx, pool, nil, &others)
	exec(`INSERT INTO track_aliases(track_id,file_path,title,artist_names,album_title) VALUES($1,'/gone/late.flac','Late',$2,$3)`,
		late, artistA, albumTitle)
	lateBefore := snapshotTrack(t, ctx, pool, late)
	if n, err := lib.AdoptFullerAliases(ctx); err != nil || n != 0 {
		t.Fatalf("second pass = %d, %v", n, err)
	}
	if got := snapshotTrack(t, ctx, pool, late); !reflect.DeepEqual(got, lateBefore) {
		t.Fatalf("second pass changed a track:\n got %+v\nwant %+v", got, lateBefore)
	}

	// A fuller copy adopted later puts each swapped set of tags back with the
	// file it came from before recording the old file as an alias.
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	finalPath := "/music/final-" + sfx + ".flac"
	old, err := library.AdoptDuplicate(ctx, tx, partial, library.Fullness{HasArtists: true, HasAlbum: true},
		library.TrackInsert{Title: "Final", AlbumID: &album, FilePath: finalPath, FileSize: 1, Format: "flac"},
		[]uuid.UUID{byB}, []string{"primary"})
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	wantPartial := trackSnapshot{
		Title: "Final", FilePath: finalPath, Album: albumTitle, Artists: []string{artistB + ":primary"},
		Aliases: []string{"/gone/partial.flac|Partial|" + artistA + "|", partialPath + "|" + partialTitle + "||Others"},
	}
	if got := snapshotTrack(t, ctx, pool, partial); old != partialPath || !reflect.DeepEqual(got, wantPartial) {
		t.Fatalf("adopted after a swap (old %q):\n got %+v\nwant %+v", old, got, wantPartial)
	}
	var stillSwapped bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM track_aliases WHERE track_id=$1 AND tags_swapped)`, partial).Scan(&stillSwapped); err != nil || stillSwapped {
		t.Fatalf("swap left marked: %v, %v", stillSwapped, err)
	}

	// The versions returned per track are capped.
	exec(`INSERT INTO track_aliases(track_id,file_path,title) SELECT $1, '/gone/copy-' || i, 'Copy ' || i FROM generate_series(1, $2::int) i`,
		late, library.MaxTrackAliases+5)
	versions, _ = getTrackVersions(t, ctx, pool, lib, viewer, late)
	if len(versions.Aliases) != library.MaxTrackAliases || versions.AliasCount != library.MaxTrackAliases+6 {
		t.Fatalf("capped versions: %d of %d", len(versions.Aliases), versions.AliasCount)
	}
}
