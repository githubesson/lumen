package integration

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/httpapi/handlers"
	"github.com/githubesson/lumen/internal/httpapi/middleware"
	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/playlists"
	"github.com/githubesson/lumen/internal/storage"
)

// writeWAV writes an untagged 24-bit stereo 44.1 kHz PCM WAV of the given
// length whose samples repeat audio, so files with different audio differ.
func writeWAV(t *testing.T, path, audio string, seconds int) {
	t.Helper()
	const rate, channels, bits = 44100, 2, 24
	align := channels * bits / 8
	data := []byte(strings.Repeat(audio, rate*align*seconds/len(audio)+1))[:rate*align*seconds]
	le16, le32 := binary.LittleEndian.AppendUint16, binary.LittleEndian.AppendUint32
	b := append([]byte("RIFF"), le32(nil, uint32(36+len(data)))...)
	b = append(b, "WAVEfmt "...)
	b = le32(b, 16)
	b = le16(b, 1) // PCM
	b = le16(b, channels)
	b = le32(b, rate)
	b = le32(b, uint32(rate*align))
	b = le16(b, uint16(align))
	b = le16(b, bits)
	b = append(b, "data"...)
	b = le32(b, uint32(len(data)))
	b = append(b, data...)
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
}

// trackDetailBody is the part of GET /tracks/{id} the linking tests check.
type trackDetailBody struct {
	ID           string `json:"id"`
	FileName     string `json:"file_name"`
	TagsFileName string `json:"tags_file_name"`
	Format       string `json:"format"`
	LinkedTo     string `json:"linked_to"`
	Linked       []struct {
		ID       string `json:"id"`
		FileName string `json:"file_name"`
		Title    string `json:"title"`
		Shown    bool   `json:"shown"`
		Plays    bool   `json:"plays"`
	} `json:"linked"`
}

// linkRouter serves the track routes linking touches, as viewer.
func linkRouter(t *testing.T, ctx context.Context, pool *pgxpool.Pool, h *handlers.Tracks, viewer uuid.UUID) func(method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	token, _, err := sessions.Create(ctx, viewer, httptest.NewRequest(http.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Use(middleware.Authenticate(sessions), middleware.RequireUser)
	router.Get("/tracks/{id}", h.Get)
	router.Get("/tracks/{id}/stream", h.Stream)
	router.Post("/admin/tracks/{id}/links", h.Link)
	router.Delete("/admin/tracks/{id}/links", h.Unlink)
	return func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "session", Value: token})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
}

func decodeDetail(t *testing.T, rec *httptest.ResponseRecorder) trackDetailBody {
	t.Helper()
	var d trackDetailBody
	if err := json.Unmarshal(rec.Body.Bytes(), &d); rec.Code != http.StatusOK || err != nil {
		t.Fatalf("track detail = %d %s: %v", rec.Code, rec.Body, err)
	}
	return d
}

// An MP3-like tagged file and the untagged studio WAV of the same song: once
// linked, the library shows one track with the tagged file's metadata that
// plays the WAV, and the WAV's playlist entries and stats come along.
func TestLinkedTracksShowTheFullestTagsAndPlayTheBestFile(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	root := t.TempDir()
	sfx := uuid.NewString()[:8]
	album, artist := "Outsiders "+sfx, "Linked Artist "+sfx
	t.Cleanup(func() {
		bg := context.Background()
		pool.Exec(bg, `DELETE FROM tracks WHERE starts_with(file_path, $1)`, root)
		pool.Exec(bg, `DELETE FROM albums a WHERE title IN ($1,'Others') AND NOT EXISTS(SELECT 1 FROM tracks t WHERE t.album_id=a.id)`, album)
		pool.Exec(bg, `DELETE FROM artists WHERE name = $1`, artist)
	})
	svc := &ingest.Service{
		DB: pool, Library: lib, Storage: storage.NewLocal(root), MusicRoot: root,
		Roots:  func(context.Context) []string { return []string{root} },
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	ingestNew := func(path string) uuid.UUID {
		t.Helper()
		out := svc.IngestFileAs(ctx, path, nil)
		if out.Err != nil || !out.Inserted {
			t.Fatalf("ingest %s = %+v", path, out)
		}
		return out.TrackID
	}
	tagged := filepath.Join(root, "Calm Down.flac")
	writeFLAC(t, tagged, "tagged-audio-"+sfx, "TITLE=Calm Down "+sfx, "ARTIST="+artist, "ALBUM="+album)
	wav := filepath.Join(root, "calm down gz "+sfx+".wav")
	writeWAV(t, wav, "studio-bounce-"+sfx, 2)
	taggedID, wavID := ingestNew(tagged), ingestNew(wav)
	// Ingest probes a WAV with ffprobe; without it here, record what it reads
	// from this file (24-bit stereo at 44.1 kHz) as production would.
	if _, err := pool.Exec(ctx, `
		UPDATE tracks SET bitrate = 2116800, sample_rate = 44100, channels = 2, duration_ms = 2000
		WHERE id = $1`, wavID); err != nil {
		t.Fatal(err)
	}

	// Someone had the WAV in a playlist, favorited, with plays.
	user := redteamUser(t, ctx, pool)
	var playlistID uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO playlists(owner_id, name) VALUES ($1, 'Linked') RETURNING id`, user).Scan(&playlistID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM playlists WHERE id = $1`, playlistID) })
	if _, err := pool.Exec(ctx, `
		INSERT INTO playlist_tracks(playlist_id, position, track_id) VALUES ($1, 0, $2);
		`, playlistID, wavID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO user_track_stats(user_id, track_id, play_count, favorited, favorited_at)
		VALUES ($1, $2, 3, TRUE, NOW()), ($1, $3, 2, FALSE, NULL)`, user, wavID, taggedID); err != nil {
		t.Fatal(err)
	}

	h := &handlers.Tracks{Library: lib, Ingest: svc}
	call := linkRouter(t, ctx, pool, h, user)

	// Linked from the WAV's side, the tagged track still shows.
	d := decodeDetail(t, call(http.MethodPost, "/admin/tracks/"+wavID.String()+"/links", `{"track_id":"local:`+taggedID.String()+`"}`))
	if d.ID != taggedID.String() {
		t.Fatalf("shown track = %s, want the tagged %s", d.ID, taggedID)
	}
	if d.FileName != filepath.Base(wav) || d.TagsFileName != filepath.Base(tagged) || !strings.EqualFold(d.Format, "WAV") {
		t.Fatalf("detail plays %q (%s) with tags from %q", d.FileName, d.Format, d.TagsFileName)
	}
	if len(d.Linked) != 2 || d.Linked[0].ID != taggedID.String() || !d.Linked[0].Shown || d.Linked[0].Plays ||
		d.Linked[1].ID != wavID.String() || d.Linked[1].Shown || !d.Linked[1].Plays {
		t.Fatalf("linked = %+v", d.Linked)
	}
	if hidden := decodeDetail(t, call(http.MethodGet, "/tracks/"+wavID.String(), "")); hidden.LinkedTo != taggedID.String() {
		t.Fatalf("the WAV's own detail = %+v", hidden)
	}

	// The library lists one track, found by either file's name.
	for _, q := range []string{"Calm Down " + sfx, "calm down gz " + sfx} {
		rows, err := lib.ListTracks(ctx, library.ListTracksParams{ViewerID: user, Query: q, Limit: 5})
		if err != nil || len(rows) != 1 || rows[0].ID != taggedID {
			t.Fatalf("search %q = %+v, %v", q, rows, err)
		}
	}

	// So is an alias of the hidden file.
	if _, err := pool.Exec(ctx, `INSERT INTO track_aliases(track_id, file_path, title) VALUES ($1, $2, $3)`,
		wavID, filepath.Join(root, "zebra.wav"), "Zebra "+sfx); err != nil {
		t.Fatal(err)
	}
	if rows, err := lib.ListTracks(ctx, library.ListTracksParams{ViewerID: user, Query: "Zebra " + sfx, Limit: 5}); err != nil ||
		len(rows) != 1 || rows[0].ID != taggedID {
		t.Fatalf("search by the hidden file's alias = %+v, %v", rows, err)
	}

	// The playlist entry and stats moved onto the shown track.
	var entry uuid.UUID
	var plays int
	var favorited bool
	if err := pool.QueryRow(ctx, `SELECT track_id FROM playlist_tracks WHERE playlist_id = $1`, playlistID).Scan(&entry); err != nil || entry != taggedID {
		t.Fatalf("playlist entry = %s, %v", entry, err)
	}
	if err := pool.QueryRow(ctx, `SELECT play_count, favorited FROM user_track_stats WHERE user_id = $1 AND track_id = $2`,
		user, taggedID).Scan(&plays, &favorited); err != nil || plays != 5 || !favorited {
		t.Fatalf("merged stats = %d plays, favorited %v, %v", plays, favorited, err)
	}

	// Playback serves the WAV, and the tagged file when the WAV is gone.
	stream := func() string {
		t.Helper()
		rec := call(http.MethodGet, "/tracks/"+taggedID.String()+"/stream", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("stream = %d %s", rec.Code, rec.Body)
		}
		return rec.Body.String()
	}
	wavBytes, _ := os.ReadFile(wav)
	taggedBytes, _ := os.ReadFile(tagged)
	if stream() != string(wavBytes) {
		t.Fatal("the shown track didn't stream the WAV")
	}
	if err := os.Rename(wav, wav+".away"); err != nil {
		t.Fatal(err)
	}
	if stream() != string(taggedBytes) {
		t.Fatal("with the WAV gone, the tagged file didn't stream")
	}
	if err := os.Rename(wav+".away", wav); err != nil {
		t.Fatal(err)
	}

	// Unlinking brings the WAV back as its own track.
	d = decodeDetail(t, call(http.MethodDelete, "/admin/tracks/"+wavID.String()+"/links", ""))
	if d.ID != taggedID.String() || len(d.Linked) != 0 || d.FileName != filepath.Base(tagged) {
		t.Fatalf("after unlinking = %+v", d)
	}
	rows, err := lib.ListTracks(ctx, library.ListTracksParams{ViewerID: user, Query: "calm down gz " + sfx, Limit: 5})
	if err != nil || len(rows) != 1 || rows[0].ID != wavID {
		t.Fatalf("unlinked WAV in the library = %+v, %v", rows, err)
	}

	// When the shown track's file disappears, the WAV takes its place and
	// keeps the playlist entry and stats.
	if _, err := lib.LinkTracks(ctx, taggedID, wavID); err != nil {
		t.Fatal(err)
	}
	if err := lib.HardDeleteByPath(ctx, tagged); err != nil {
		t.Fatal(err)
	}
	var linkedTo *uuid.UUID
	var visible bool
	if err := pool.QueryRow(ctx, `SELECT linked_to, library_visible FROM tracks WHERE id = $1`, wavID).Scan(&linkedTo, &visible); err != nil ||
		linkedTo != nil || !visible {
		t.Fatalf("WAV after the shown track went: linked_to %v, visible %v, %v", linkedTo, visible, err)
	}
	if err := pool.QueryRow(ctx, `SELECT track_id FROM playlist_tracks WHERE playlist_id = $1`, playlistID).Scan(&entry); err != nil || entry != wavID {
		t.Fatalf("playlist entry after the shown track went = %s, %v", entry, err)
	}
	if err := pool.QueryRow(ctx, `SELECT play_count FROM user_track_stats WHERE user_id = $1 AND track_id = $2`,
		user, wavID).Scan(&plays); err != nil || plays != 5 {
		t.Fatalf("stats after the shown track went = %d, %v", plays, err)
	}
}

// Groups merge, a soft-deleted shown track hands its place to the fullest
// of the rest, an admin delete takes the whole group, and only live shared
// library tracks link.
func TestLinkedTrackGroups(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	root := t.TempDir()
	sfx := uuid.NewString()[:8]
	artist := "Group Artist " + sfx
	t.Cleanup(func() {
		bg := context.Background()
		pool.Exec(bg, `DELETE FROM tracks WHERE starts_with(file_path, $1)`, root)
		pool.Exec(bg, `DELETE FROM artists WHERE name = $1`, artist)
	})
	svc := &ingest.Service{
		DB: pool, Library: lib, Storage: storage.NewLocal(root), MusicRoot: root,
		Roots:  func(context.Context) []string { return []string{root} },
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	add := func(name string, tags ...string) uuid.UUID {
		t.Helper()
		p := filepath.Join(root, name)
		writeFLAC(t, p, "group-"+name+"-"+sfx, tags...)
		out := svc.IngestFileAs(ctx, p, nil)
		if out.Err != nil || !out.Inserted {
			t.Fatalf("ingest %s = %+v", p, out)
		}
		return out.TrackID
	}
	a := add("a.flac", "TITLE=Arctic "+sfx, "ARTIST="+artist)
	b, c, d := add("b.flac"), add("c.flac"), add("d.flac")
	link := func(x, y uuid.UUID) uuid.UUID {
		t.Helper()
		shown, err := lib.LinkTracks(ctx, x, y)
		if err != nil {
			t.Fatal(err)
		}
		return shown
	}
	linkedTo := func(id uuid.UUID) *uuid.UUID {
		t.Helper()
		var to *uuid.UUID
		if err := pool.QueryRow(ctx, `SELECT linked_to FROM tracks WHERE id = $1`, id).Scan(&to); err != nil {
			t.Fatal(err)
		}
		return to
	}
	if shown := link(b, c); shown != b {
		t.Fatalf("equally bare tracks: shown %s, want the target %s", shown, b)
	}
	// Linking a track of one group with a track of another merges them
	// under the fullest-tagged.
	if shown := link(c, a); shown != a {
		t.Fatalf("merged group shows %s, want the tagged %s", shown, a)
	}
	for _, id := range []uuid.UUID{b, c} {
		if to := linkedTo(id); to == nil || *to != a {
			t.Fatalf("%s linked to %v, want %s", id, to, a)
		}
	}
	if shown := link(b, c); shown != a {
		t.Fatalf("relinking within a group = %s", shown)
	}

	// Soft-deleting the shown track (its root removed) promotes the oldest of
	// the equally bare rest.
	if err := lib.SoftDeleteByPath(ctx, filepath.Join(root, "a.flac")); err != nil {
		t.Fatal(err)
	}
	if to := linkedTo(b); to != nil {
		t.Fatalf("b still linked to %s", to)
	}
	if to := linkedTo(c); to == nil || *to != b {
		t.Fatalf("c linked to %v, want %s", to, b)
	}

	// An admin delete of the shown track removes the group and its files.
	paths, err := lib.DeleteGlobalTrack(ctx, b)
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 2 || !strings.HasSuffix(paths[0], "b.flac") || !strings.HasSuffix(paths[1], "c.flac") {
		t.Fatalf("deleted paths = %v", paths)
	}
	var left int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM tracks WHERE id IN ($1, $2)`, b, c).Scan(&left); err != nil || left != 0 {
		t.Fatalf("%d group rows left, %v", left, err)
	}

	// Only live shared library tracks link.
	user := redteamUser(t, ctx, pool)
	personal := redteamTrack(t, ctx, pool, &user, nil)
	for name, pair := range map[string][2]uuid.UUID{
		"itself":   {d, d},
		"personal": {d, personal},
		"deleted":  {d, a},
	} {
		if _, err := lib.LinkTracks(ctx, pair[0], pair[1]); !errors.Is(err, library.ErrInvalidInput) && !errors.Is(err, library.ErrNotFound) {
			t.Fatalf("linking %s = %v", name, err)
		}
	}
	if to := linkedTo(d); to != nil {
		t.Fatalf("d linked to %s after refused links", to)
	}

	// One statement can delete a whole group, the shown track first or not.
	e := add("e.flac")
	link(d, e)
	if _, err := pool.Exec(ctx, `DELETE FROM tracks WHERE id IN ($1, $2)`, d, e); err != nil {
		t.Fatalf("deleting a group in one statement: %v", err)
	}
}

// A track soft-deleted with its root keeps its link. When its group is merged
// under another track, or its shown track unlinked, it follows to the new
// shown track, so deleting the old one doesn't trip the foreign key.
func TestLinksStayOneLevelDeep(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	track := func(tagged bool) (uuid.UUID, string) {
		t.Helper()
		id := redteamTrack(t, ctx, pool, nil, nil)
		if tagged {
			credit(t, ctx, pool, id, pageArtist(t, ctx, pool, "Deep"))
		}
		var path string
		if err := pool.QueryRow(ctx, `SELECT file_path FROM tracks WHERE id = $1`, id).Scan(&path); err != nil {
			t.Fatal(err)
		}
		return id, path
	}
	link := func(x, y uuid.UUID) uuid.UUID {
		t.Helper()
		shown, err := lib.LinkTracks(ctx, x, y)
		if err != nil {
			t.Fatal(err)
		}
		return shown
	}
	linkedTo := func(id uuid.UUID) *uuid.UUID {
		t.Helper()
		var to *uuid.UUID
		if err := pool.QueryRow(ctx, `SELECT linked_to FROM tracks WHERE id = $1`, id).Scan(&to); err != nil {
			t.Fatal(err)
		}
		return to
	}

	s, sPath := track(false)
	l, lPath := track(false)
	s2, _ := track(true)
	link(s, l)
	if err := lib.SoftDeleteByPath(ctx, lPath); err != nil {
		t.Fatal(err)
	}
	if shown := link(s, s2); shown != s2 {
		t.Fatalf("merged group shows %s, want the credited %s", shown, s2)
	}
	if to := linkedTo(l); to == nil || *to != s2 {
		t.Fatalf("soft-deleted track linked to %v, want %s", to, s2)
	}
	if err := lib.HardDeleteByPath(ctx, sPath); err != nil {
		t.Fatalf("deleting the formerly shown track: %v", err)
	}
	if _, err := lib.DeleteGlobalTrack(ctx, s2); err != nil {
		t.Fatalf("deleting the group: %v", err)
	}

	p, pPath := track(true)
	m1, m1Path := track(false)
	m2, m2Path := track(false)
	link(p, m1)
	link(p, m2)
	if err := lib.SoftDeleteByPath(ctx, m2Path); err != nil {
		t.Fatal(err)
	}
	if shown, err := lib.UnlinkTrack(ctx, p); err != nil || shown != m1 {
		t.Fatalf("unlinking the shown track = %s, %v; want %s", shown, err, m1)
	}
	if to := linkedTo(m2); to == nil || *to != m1 {
		t.Fatalf("soft-deleted track linked to %v, want %s", to, m1)
	}
	for _, path := range []string{pPath, m1Path} {
		if err := lib.HardDeleteByPath(ctx, path); err != nil {
			t.Fatalf("deleting %s: %v", path, err)
		}
	}
	if to := linkedTo(m2); to != nil {
		t.Fatalf("soft-deleted track still linked to %s after its group went", to)
	}
}

// Two admins linking the same pair from either side both succeed.
func TestConcurrentLinksOfOnePairBothSucceed(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	for range 15 {
		a, b := redteamTrack(t, ctx, pool, nil, nil), redteamTrack(t, ctx, pool, nil, nil)
		var shown [2]uuid.UUID
		var errs [2]error
		var wg sync.WaitGroup
		for i, pair := range [2][2]uuid.UUID{{a, b}, {b, a}} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				shown[i], errs[i] = lib.LinkTracks(ctx, pair[0], pair[1])
			}()
		}
		wg.Wait()
		if errs[0] != nil || errs[1] != nil || shown[0] != shown[1] {
			t.Fatalf("concurrent links = %s %v, %s %v", shown[0], errs[0], shown[1], errs[1])
		}
	}
}

// Links and unlinks racing over a few tracks either succeed or ask the
// caller to try again; none fails outright (a deadlock surfaced as a 500),
// and the groups stay one level deep, hidden exactly when linked.
func TestConcurrentLinkingKeepsGroupsConsistent(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	ids := make([]uuid.UUID, 8)
	for i := range ids {
		ids[i] = redteamTrack(t, ctx, pool, nil, nil)
	}
	for range 3 {
		var wg sync.WaitGroup
		errs := make([]error, 40)
		for i := range errs {
			wg.Add(1)
			go func() {
				defer wg.Done()
				a, b := ids[rand.IntN(len(ids))], ids[rand.IntN(len(ids))]
				if i%3 == 0 {
					_, errs[i] = lib.UnlinkTrack(ctx, a)
				} else {
					_, errs[i] = lib.LinkTracks(ctx, a, b)
				}
			}()
		}
		wg.Wait()
		for _, err := range errs {
			if err != nil && !errors.Is(err, library.ErrInvalidInput) {
				t.Fatalf("a racing link failed outright: %v", err)
			}
		}
	}
	var chained, misplaced int
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FILTER (WHERE h.linked_to IS NOT NULL),
		       COUNT(*) FILTER (WHERE t.library_visible <> (t.linked_to IS NULL))
		FROM tracks t LEFT JOIN tracks h ON h.id = t.linked_to
		WHERE t.id = ANY($1)`, ids).Scan(&chained, &misplaced); err != nil {
		t.Fatal(err)
	}
	if chained != 0 || misplaced != 0 {
		t.Fatalf("%d tracks linked to a linked track, %d hidden or shown wrongly", chained, misplaced)
	}
}

// Adding a track to a playlist while an admin links it never fails: the
// link's row locks leave room for the entry's foreign-key check.
func TestPlaylistAddsDuringALinkSucceed(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	pls := playlists.NewStore(pool)
	user := redteamUser(t, ctx, pool)
	pl, err := pls.Create(ctx, user, "Racing "+uuid.NewString()[:8], "", playlists.VisibilityPrivate)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM playlists WHERE id = $1`, pl.ID) })
	for range 60 {
		mp3, wav := redteamTrack(t, ctx, pool, nil, nil), redteamTrack(t, ctx, pool, nil, nil)
		// The playlist already holds the WAV, so the link moves that entry.
		if err := pls.AddEntries(ctx, pl.ID, []uuid.UUID{wav}, nil, user); err != nil {
			t.Fatal(err)
		}
		var linkErr, addErr error
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); _, linkErr = lib.LinkTracks(ctx, mp3, wav) }()
		go func() { defer wg.Done(); addErr = pls.AddEntries(ctx, pl.ID, []uuid.UUID{mp3}, nil, user) }()
		wg.Wait()
		if linkErr != nil || addErr != nil {
			t.Fatalf("link = %v, playlist add = %v", linkErr, addErr)
		}
	}
}

// A play recorded on a track while a link hides it still counts: the link
// waits for the play's stats row and carries its count over.
func TestPlayRecordedDuringALinkIsKept(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	user := redteamUser(t, ctx, pool)
	shown, hidden := redteamTrack(t, ctx, pool, nil, nil), redteamTrack(t, ctx, pool, nil, nil)
	credit(t, ctx, pool, shown, pageArtist(t, ctx, pool, "Kept"))
	if _, err := pool.Exec(ctx, `INSERT INTO user_track_stats(user_id, track_id, play_count) VALUES ($1, $2, 5)`, user, hidden); err != nil {
		t.Fatal(err)
	}

	// A play of the hidden-to-be track, written as RecordPlay writes it, is
	// under way: its stats row is bumped and locked.
	play, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer play.Rollback(ctx)
	if _, err := play.Exec(ctx, `
		INSERT INTO user_track_stats(user_id, track_id, play_count, last_played_at) VALUES ($1, $2, 1, NOW())
		ON CONFLICT (user_id, track_id) DO UPDATE SET play_count = user_track_stats.play_count + 1, last_played_at = NOW()`,
		user, hidden); err != nil {
		t.Fatal(err)
	}
	linked := make(chan error, 1)
	go func() {
		_, err := lib.LinkTracks(ctx, shown, hidden)
		linked <- err
	}()
	// The link waits on that row; then the play finishes.
	deadline := time.Now().Add(10 * time.Second)
	for {
		var waiting int
		if err := pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock'`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the link never waited on the play")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := play.Exec(ctx, `INSERT INTO play_history(user_id, track_id) VALUES ($1, $2)`, user, hidden); err != nil {
		t.Fatal(err)
	}
	if err := play.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-linked; err != nil {
		t.Fatal(err)
	}
	var onShown, onHidden int
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(play_count) FILTER (WHERE track_id = $2), 0),
		       COALESCE(SUM(play_count) FILTER (WHERE track_id = $3), 0)
		FROM user_track_stats WHERE user_id = $1`, user, shown, hidden).Scan(&onShown, &onHidden); err != nil {
		t.Fatal(err)
	}
	if onShown != 6 || onHidden != 0 {
		t.Fatalf("plays after the link: %d on the shown track, %d on the hidden one; want 6 and 0", onShown, onHidden)
	}
}

// A client that still holds a hidden track's id writes for the song: plays,
// favorites and playlist entries land on the shown track. Any that reached
// the hidden row anyway follow the song when the hidden file goes.
func TestWritesForAHiddenTrackLandOnTheSong(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	pls := playlists.NewStore(pool)
	user := redteamUser(t, ctx, pool)
	shown, hidden, other := redteamTrack(t, ctx, pool, nil, nil), redteamTrack(t, ctx, pool, nil, nil), redteamTrack(t, ctx, pool, nil, nil)
	credit(t, ctx, pool, shown, pageArtist(t, ctx, pool, "Song"))
	for _, id := range []uuid.UUID{hidden, other} {
		if s, err := lib.LinkTracks(ctx, shown, id); err != nil || s != shown {
			t.Fatalf("link = %s, %v", s, err)
		}
	}
	pl, err := pls.Create(ctx, user, "Hidden ids "+uuid.NewString()[:8], "", playlists.VisibilityPrivate)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM playlists WHERE id = $1`, pl.ID) })

	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	token, _, err := sessions.Create(ctx, user, httptest.NewRequest(http.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Use(middleware.Authenticate(sessions), middleware.RequireUser)
	tracksH := &handlers.Tracks{Library: lib}
	router.Post("/tracks/{id}/favorite", tracksH.Favorite)
	router.Delete("/tracks/{id}/favorite", tracksH.Unfavorite)
	router.Post("/tracks/{id}/play", tracksH.RecordPlay)
	router.Post("/playlists/{id}/tracks", (&handlers.Playlists{Store: pls, Library: lib}).AddTracks)
	call := func(method, path, body string) {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "session", Value: token})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code >= 300 {
			t.Fatalf("%s %s = %d %s", method, path, rec.Code, rec.Body)
		}
	}
	stats := func(id uuid.UUID) (plays int, favorited bool) {
		t.Helper()
		err := pool.QueryRow(ctx, `SELECT play_count, favorited FROM user_track_stats WHERE user_id = $1 AND track_id = $2`,
			user, id).Scan(&plays, &favorited)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal(err)
		}
		return plays, favorited
	}
	entries := func() []uuid.UUID {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT track_id FROM playlist_tracks WHERE playlist_id = $1 ORDER BY position`, pl.ID)
		if err != nil {
			t.Fatal(err)
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
		if err != nil {
			t.Fatal(err)
		}
		return ids
	}

	call(http.MethodPost, "/tracks/"+hidden.String()+"/favorite", "")
	call(http.MethodPost, "/tracks/"+hidden.String()+"/play", "")
	call(http.MethodPost, "/playlists/"+pl.ID.String()+"/tracks", `{"track_ids":["`+hidden.String()+`"]}`)
	if plays, fav := stats(shown); plays != 1 || !fav {
		t.Fatalf("shown track: %d plays, favorited %v", plays, fav)
	}
	if plays, fav := stats(hidden); plays != 0 || fav {
		t.Fatalf("hidden track: %d plays, favorited %v", plays, fav)
	}
	if got := entries(); len(got) != 1 || got[0] != shown {
		t.Fatalf("playlist entries = %v, want the shown track", got)
	}
	call(http.MethodDelete, "/tracks/"+hidden.String()+"/favorite", "")
	if _, fav := stats(shown); fav {
		t.Fatal("unfavoriting the hidden id left the song favorited")
	}

	// References that reached hidden rows anyway follow the song when the
	// files go: one pruned, one soft-deleted with its root.
	for i, id := range []uuid.UUID{hidden, other} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO user_track_stats(user_id, track_id, play_count) VALUES ($1, $2, 2)`, user, id); err != nil {
			t.Fatal(err)
		}
		if err := pls.AddEntries(ctx, pl.ID, []uuid.UUID{id}, nil, user); err != nil {
			t.Fatal(err)
		}
		var path string
		if err := pool.QueryRow(ctx, `SELECT file_path FROM tracks WHERE id = $1`, id).Scan(&path); err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			err = lib.HardDeleteByPath(ctx, path)
		} else {
			err = lib.SoftDeleteByPath(ctx, path)
		}
		if err != nil {
			t.Fatal(err)
		}
		if plays, _ := stats(shown); plays != 1+2*(i+1) {
			t.Fatalf("after %s went: %d plays on the shown track", path, plays)
		}
		if got := entries(); len(got) != 2+i || slices.ContainsFunc(got, func(e uuid.UUID) bool { return e != shown }) {
			t.Fatalf("after %s went: playlist entries %v", path, got)
		}
	}
}

// One statement taking the shown track and a hidden file (a root purge, a
// bulk delete) hands both files' plays and playlist entries to a linked
// file that survives, whichever row the statement reaches first.
func TestOneStatementDeleteHandsRefsToTheSurvivor(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	pls := playlists.NewStore(pool)
	user := redteamUser(t, ctx, pool)
	pl, err := pls.Create(ctx, user, "Survivor "+uuid.NewString()[:8], "", playlists.VisibilityPrivate)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM playlists WHERE id = $1`, pl.ID) })
	for i := range 8 {
		shown, hidden, third := redteamTrack(t, ctx, pool, nil, nil), redteamTrack(t, ctx, pool, nil, nil), redteamTrack(t, ctx, pool, nil, nil)
		credit(t, ctx, pool, shown, pageArtist(t, ctx, pool, "Survivor"))
		for _, id := range []uuid.UUID{hidden, third} {
			if _, err := lib.LinkTracks(ctx, shown, id); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO user_track_stats(user_id, track_id, play_count) VALUES ($1, $2, 1), ($1, $3, 2)`,
			user, shown, hidden); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM playlist_tracks WHERE playlist_id = $1`, pl.ID); err != nil {
			t.Fatal(err)
		}
		if err := pls.AddEntries(ctx, pl.ID, []uuid.UUID{hidden}, nil, user); err != nil {
			t.Fatal(err)
		}
		gone := []uuid.UUID{shown, hidden}
		if i%2 == 0 {
			_, err = pool.Exec(ctx, `UPDATE tracks SET deleted_at = NOW() WHERE id = ANY($1)`, gone)
		} else {
			_, err = pool.Exec(ctx, `DELETE FROM tracks WHERE id = ANY($1)`, gone)
		}
		if err != nil {
			t.Fatal(err)
		}
		var plays int
		var linkedTo *uuid.UUID
		var visible bool
		var entry uuid.UUID
		if err := pool.QueryRow(ctx, `
			SELECT COALESCE((SELECT play_count FROM user_track_stats WHERE user_id = $1 AND track_id = t.id), 0),
			       t.linked_to, t.library_visible,
			       (SELECT track_id FROM playlist_tracks WHERE playlist_id = $3)
			FROM tracks t WHERE t.id = $2`, user, third, pl.ID).Scan(&plays, &linkedTo, &visible, &entry); err != nil {
			t.Fatal(err)
		}
		if plays != 3 || linkedTo != nil || !visible || entry != third {
			t.Fatalf("round %d: survivor has %d plays, linked to %v, visible %v; playlist entry on %s",
				i, plays, linkedTo, visible, entry)
		}
	}
}

// A prune of the shown file and an admin delete of the hidden one don't
// deadlock: both lock the group the way links do.
func TestPruneAndAdminDeleteOfOneGroupBothSucceed(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	user := redteamUser(t, ctx, pool)
	for range 30 {
		shown, hidden := redteamTrack(t, ctx, pool, nil, nil), redteamTrack(t, ctx, pool, nil, nil)
		if _, err := lib.LinkTracks(ctx, shown, hidden); err != nil {
			t.Fatal(err)
		}
		// References on both, so each delete writes onto the other's row.
		if _, err := pool.Exec(ctx, `
			INSERT INTO user_track_stats(user_id, track_id, play_count) VALUES ($1, $2, 1), ($1, $3, 1)`,
			user, shown, hidden); err != nil {
			t.Fatal(err)
		}
		var shownPath string
		if err := pool.QueryRow(ctx, `SELECT file_path FROM tracks WHERE id = $1`, shown).Scan(&shownPath); err != nil {
			t.Fatal(err)
		}
		var pruneErr, deleteErr error
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); pruneErr = lib.HardDeleteByPath(ctx, shownPath) }()
		go func() { defer wg.Done(); _, deleteErr = lib.DeleteGlobalTrack(ctx, hidden) }()
		wg.Wait()
		if pruneErr != nil || deleteErr != nil {
			t.Fatalf("prune = %v, admin delete = %v", pruneErr, deleteErr)
		}
		var left int
		if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM tracks WHERE id IN ($1, $2)`, shown, hidden).Scan(&left); err != nil || left != 0 {
			t.Fatalf("%d of the group's tracks left, %v", left, err)
		}
	}
}
