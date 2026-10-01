package tidaldl

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubesson/lumen/internal/ingest"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/storage"
	"github.com/githubesson/lumen/internal/tidal"
)

// fakeCatalog answers the matcher's TIDAL calls: every search returns its
// whole list (the matcher does the filtering), and releases come from albums.
type fakeCatalog struct {
	mu           sync.Mutex
	searchAlbums []tidal.Album
	searchTracks []tidal.Track
	// byQuery, when set, answers track searches by query instead.
	byQuery map[string][]tidal.Track
	albums  map[string]tidal.Album
	err     error
	fetched []string
	cover   func() ([]byte, error) // nil: covers fail
	// coverCalls counts cover fetches.
	coverCalls int
}

func (f *fakeCatalog) SearchTracks(_ context.Context, query string, _, _ int) ([]tidal.Track, error) {
	if f.byQuery != nil {
		return f.byQuery[query], f.err
	}
	return f.searchTracks, f.err
}

func (f *fakeCatalog) SearchAlbums(context.Context, string, int, int) ([]tidal.Album, int, error) {
	return f.searchAlbums, len(f.searchAlbums), f.err
}

func (f *fakeCatalog) FullAlbum(_ context.Context, id string) (tidal.Album, error) {
	f.mu.Lock()
	f.fetched = append(f.fetched, id)
	f.mu.Unlock()
	if f.err != nil {
		return tidal.Album{}, f.err
	}
	a, ok := f.albums[id]
	if !ok {
		return tidal.Album{}, errors.New("album not found")
	}
	return a, nil
}

func (f *fakeCatalog) CoverBytes(context.Context, string) ([]byte, error) {
	f.mu.Lock()
	f.coverCalls++
	f.mu.Unlock()
	if f.cover == nil {
		return nil, errors.New("no covers in tests")
	}
	return f.cover()
}

// matchFixture inserts library rows for matcher tests and removes them after.
type matchFixture struct {
	t    *testing.T
	pool *pgxpool.Pool
	lib  *library.Store
	run  string
}

func newMatchFixture(t *testing.T) *matchFixture {
	pool := testPool(t)
	f := &matchFixture{t: t, pool: pool, lib: library.NewStore(pool), run: uuid.NewString()[:8]}
	t.Cleanup(func() {
		ctx := context.Background()
		like := "%" + f.run + "%"
		pool.Exec(ctx, `DELETE FROM tracks WHERE file_path LIKE $1`, like)
		pool.Exec(ctx, `DELETE FROM albums WHERE title LIKE $1`, like)
		pool.Exec(ctx, `DELETE FROM artists WHERE name LIKE $1`, like)
		pool.Exec(ctx, `DELETE FROM tidal_albums WHERE tidal_id LIKE $1`, like)
		pool.Exec(ctx, `DELETE FROM users WHERE username LIKE $1`, like)
	})
	return f
}

func (f *matchFixture) exec(sql string, args ...any) {
	f.t.Helper()
	if _, err := f.pool.Exec(context.Background(), sql, args...); err != nil {
		f.t.Fatal(err)
	}
}

// album creates a library album; artist "" leaves it without an album
// artist, as ingest does for files without that tag.
func (f *matchFixture) album(title, artist string, year int) uuid.UUID {
	f.t.Helper()
	ctx := context.Background()
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	var artistID *uuid.UUID
	if artist != "" {
		id, err := library.UpsertArtist(ctx, tx, artist)
		if err != nil {
			f.t.Fatal(err)
		}
		artistID = &id
	}
	id, err := library.UpsertAlbum(ctx, tx, title, artistID, year, artist == "", "", nil)
	if err != nil {
		f.t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		f.t.Fatal(err)
	}
	return id
}

type localTrack struct {
	title     string
	artists   []string
	composer  string
	album     *uuid.UUID
	duration  int
	trackNo   int
	isrc      string
	owner     *uuid.UUID
	edited    bool
	fresh     bool // just ingested
	extraPath string
}

func (f *matchFixture) track(in localTrack) uuid.UUID {
	f.t.Helper()
	ctx := context.Background()
	id := uuid.New()
	// Ingested a while ago, so the matcher considers it settled.
	age := "1 hour"
	if in.fresh {
		age = "0"
	}
	f.exec(`INSERT INTO tracks(id, owner_id, album_id, title, duration_ms, track_no, isrc, file_path, file_size, format,
	            audio_sha256, metadata_edited_at, created_at, updated_at)
	        VALUES($1, $2, $3, $4, $5, NULLIF($6, 0), NULLIF($7, ''), $8, 5, 'flac', $9,
	            CASE WHEN $10 THEN NOW() END, NOW() - $11::interval, NOW() - $11::interval)`,
		id, in.owner, in.album, in.title, in.duration, in.trackNo, in.isrc,
		"/music/"+f.run+"/"+id.String()+in.extraPath+".flac", id[:], in.edited, age)
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := library.ReplaceTrackArtists(ctx, tx, id, in.artists); err != nil {
		f.t.Fatal(err)
	}
	if in.composer != "" {
		cid, err := library.UpsertArtist(ctx, tx, in.composer)
		if err != nil {
			f.t.Fatal(err)
		}
		if err := library.LinkTrackArtists(ctx, tx, id, []uuid.UUID{cid}, []string{"composer"}); err != nil {
			f.t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		f.t.Fatal(err)
	}
	return id
}

// state is what a track looks like after matching.
type state struct {
	Title, ISRC, Album, AlbumArtist, TIDALAlbum string
	Artists, Composers                          []string
	AlbumID                                     uuid.UUID
	Year, TrackNo, DiscNo                       int
	Edited                                      bool
	Match                                       string // tidal_matches status, "" for none
	MatchAlbum                                  string
	Retry                                       *time.Time
}

func (f *matchFixture) state(id uuid.UUID) state {
	f.t.Helper()
	var s state
	if err := f.pool.QueryRow(context.Background(), `
		SELECT t.title, COALESCE(t.isrc, ''), COALESCE(a.title, ''), COALESCE(aa.name, ''),
		       COALESCE(a.tidal_album_id, ''), COALESCE(t.album_id, '00000000-0000-0000-0000-000000000000'::uuid),
		       ARRAY(SELECT ar.name FROM track_artists ta JOIN artists ar ON ar.id = ta.artist_id
		             WHERE ta.track_id = t.id AND ta.role <> 'composer' ORDER BY ta.position),
		       ARRAY(SELECT ar.name FROM track_artists ta JOIN artists ar ON ar.id = ta.artist_id
		             WHERE ta.track_id = t.id AND ta.role = 'composer'),
		       COALESCE(t.year, 0), COALESCE(t.track_no, 0), COALESCE(t.disc_no, 0),
		       t.metadata_edited_at IS NOT NULL,
		       COALESCE(m.status, ''), COALESCE(m.tidal_album_id, ''), m.next_attempt_at
		FROM tracks t
		LEFT JOIN albums a ON a.id = t.album_id
		LEFT JOIN artists aa ON aa.id = a.album_artist_id
		LEFT JOIN tidal_matches m ON m.track_id = t.id
		WHERE t.id = $1`, id).Scan(&s.Title, &s.ISRC, &s.Album, &s.AlbumArtist, &s.TIDALAlbum, &s.AlbumID,
		&s.Artists, &s.Composers, &s.Year, &s.TrackNo, &s.DiscNo, &s.Edited, &s.Match, &s.MatchAlbum, &s.Retry); err != nil {
		f.t.Fatal(err)
	}
	return s
}

func (f *matchFixture) matcher(src *fakeCatalog) *Matcher {
	return &Matcher{
		Store:    NewStore(f.pool),
		Library:  f.lib,
		source:   src,
		pace:     -1,
		readISRC: func(string) string { return "" },
	}
}

func TestMatcherFilesAlbumUnderItsRelease(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	main := "Main " + f.run
	title := "Record " + f.run
	// No album artist tag: ingest files that as a compilation.
	albumID := f.album(title, "", 0)
	intro := f.track(localTrack{title: "intro", artists: []string{main}, composer: "Writer " + f.run,
		album: &albumID, duration: 60_200, trackNo: 1})
	song := f.track(localTrack{title: "Song (feat. Guest " + f.run + ")", artists: []string{main},
		album: &albumID, duration: 180_400, trackNo: 2})
	bonus := f.track(localTrack{title: "Bonus", artists: []string{main}, album: &albumID, duration: 100_000, trackNo: 9})
	edited := f.track(localTrack{title: "Intro", artists: []string{main}, album: &albumID, duration: 60_000, edited: true})

	relID, singleID := "rel"+f.run, "single"+f.run
	rel := tidal.Album{
		ID: relID, Title: title + " (Deluxe Edition)", Artist: main, Artists: []string{main}, ReleaseYear: 2001,
		TrackCount: 3,
		Tracks: []tidal.Track{
			{ID: "a" + f.run, Title: "Intro", Artists: []string{main}, DurationMS: 60_000, TrackNo: 1, DiscNo: 1, ISRC: "GBAYE0100001"},
			{ID: "b" + f.run, Title: "Song", Artists: []string{main, "Guest " + f.run}, DurationMS: 181_000, TrackNo: 2, DiscNo: 1, ISRC: "GBAYE0100002"},
			{ID: "c" + f.run, Title: "Outro", Artists: []string{main}, DurationMS: 90_000, TrackNo: 3, DiscNo: 1},
		},
	}
	single := tidal.Album{
		ID: singleID, Title: title + " - Single", Artist: main, Artists: []string{main}, ReleaseYear: 2000,
		Tracks: []tidal.Track{{ID: "s" + f.run, Title: "Song", Artists: []string{main}, DurationMS: 181_000, TrackNo: 1}},
	}
	src := &fakeCatalog{
		searchAlbums: []tidal.Album{single, rel, {ID: "other" + f.run, Title: title, Artist: "Somebody Else"}},
		albums:       map[string]tidal.Album{relID: rel, singleID: single},
	}
	m := f.matcher(src)

	pending, err := m.Store.PendingMatchAlbums(ctx, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if !containsID(pending, albumID) {
		t.Fatal("album with unmatched tracks isn't pending")
	}
	if err := m.matchAlbum(ctx, albumID); err != nil {
		t.Fatal(err)
	}
	for _, id := range src.fetched {
		if id == "other"+f.run {
			t.Fatal("fetched a release by another artist")
		}
	}

	got := f.state(intro)
	if got.Title != "Intro" || got.ISRC != "GBAYE0100001" || got.Album != rel.Title || got.AlbumArtist != main ||
		got.TIDALAlbum != relID || got.Year != 2001 || got.TrackNo != 1 || got.DiscNo != 1 || !got.Edited ||
		got.Match != MatchMatched || got.Retry != nil {
		t.Fatalf("intro = %+v", got)
	}
	if len(got.Artists) != 1 || got.Artists[0] != main || len(got.Composers) != 1 {
		t.Fatalf("intro artists = %v, composers = %v; the file's composer should stay", got.Artists, got.Composers)
	}
	got = f.state(song)
	if got.Title != "Song" || strings.Join(got.Artists, "|") != main+"|Guest "+f.run || got.AlbumID != f.state(intro).AlbumID {
		t.Fatalf("song = %+v", got)
	}
	// The bonus track isn't on the release but stays with its album.
	got = f.state(bonus)
	if got.Title != "Bonus" || got.AlbumID != f.state(intro).AlbumID || got.Year != 2001 || got.Edited ||
		got.Match != MatchUnmatched || got.MatchAlbum != relID || got.Retry == nil ||
		time.Until(*got.Retry) < 29*24*time.Hour {
		t.Fatalf("bonus = %+v", got)
	}
	// Metadata set on purpose is never touched.
	if got := f.state(edited); got.AlbumID != albumID || got.Match != "" {
		t.Fatalf("edited track = %+v", got)
	}
	// The release is stored for the album page.
	if stored, _, err := f.lib.TIDALAlbum(ctx, relID); err != nil || len(stored.Tracks) != 3 {
		t.Fatalf("release not stored: %+v, %v", stored, err)
	}
	if _, _, err := f.lib.TIDALAlbum(ctx, singleID); !errors.Is(err, library.ErrNotFound) {
		t.Fatalf("a release that wasn't used was stored: %v", err)
	}

	// Nothing waits any more.
	pending, err = m.Store.PendingMatchAlbums(ctx, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if containsID(pending, albumID) || containsID(pending, f.state(intro).AlbumID) {
		t.Fatal("matched album still pending")
	}
}

func TestMatcherLeavesAlbumWithoutConfidentRelease(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	main := "Main " + f.run
	title := "Mixtape " + f.run
	albumID := f.album(title, main, 0)
	var ids []uuid.UUID
	for i, name := range []string{"One", "Two", "Three", "Four"} {
		ids = append(ids, f.track(localTrack{title: name, artists: []string{main}, album: &albumID,
			duration: 100_000 + i*10_000, trackNo: i + 1}))
	}
	// A release of that title holds just one of the four.
	relID := "rel" + f.run
	rel := tidal.Album{ID: relID, Title: title, Artist: main, Tracks: []tidal.Track{
		{ID: "a" + f.run, Title: "One", Artists: []string{main}, DurationMS: 100_000, TrackNo: 1},
	}}
	src := &fakeCatalog{
		searchAlbums: []tidal.Album{rel},
		searchTracks: []tidal.Track{{ID: "a" + f.run, Title: "One", Artists: []string{main}, DurationMS: 100_000,
			AlbumID: relID, AlbumTitle: title, AlbumArtist: main}},
		albums: map[string]tidal.Album{relID: rel},
	}
	if err := f.matcher(src).matchAlbum(ctx, albumID); err != nil {
		t.Fatal(err)
	}
	for _, id := range ids {
		got := f.state(id)
		if got.AlbumID != albumID || got.Edited || got.Match != MatchUnmatched || got.MatchAlbum != "" {
			t.Fatalf("track = %+v; want it untouched and unmatched", got)
		}
	}
}

func TestMatcherMatchesLooseTracks(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	solo := "Solo " + f.run
	isrc := "GBAYE0600001"
	loose := f.track(localTrack{title: "Lonely", artists: []string{solo}, duration: 200_000, extraPath: "-isrc"})
	bare := f.track(localTrack{title: "Untitled"})
	owner := uuid.New()
	f.exec(`INSERT INTO users(id, username, password_hash, role) VALUES($1, $2, 'x', 'user')`, owner, "match-"+f.run)
	personal := f.track(localTrack{title: "Lonely", artists: []string{solo}, duration: 200_000, owner: &owner})
	// Whoever added it may still be setting its metadata.
	fresh := f.track(localTrack{title: "Lonely", artists: []string{solo}, duration: 200_000, fresh: true})

	relID := "rel" + f.run
	hit := tidal.Track{ID: "b" + f.run, Title: "Lonely", Artists: []string{solo}, DurationMS: 200_000,
		ISRC: isrc, AlbumID: relID, AlbumTitle: "Debut " + f.run, AlbumArtist: solo}
	rel := tidal.Album{ID: relID, Title: "Debut " + f.run, Artist: solo, ReleaseYear: 1999,
		Tracks: []tidal.Track{{ID: hit.ID, Title: "Lonely", Artists: []string{solo}, DurationMS: 200_000, ISRC: isrc, TrackNo: 4}}}
	src := &fakeCatalog{
		searchTracks: []tidal.Track{
			{ID: "a" + f.run, Title: "Lonely", Artists: []string{solo}, DurationMS: 200_000,
				AlbumID: "comp" + f.run, AlbumTitle: "Hits " + f.run, AlbumArtist: "Various Artists"},
			hit,
		},
		albums: map[string]tidal.Album{relID: rel},
	}
	m := f.matcher(src)
	m.readISRC = func(path string) string {
		if strings.HasSuffix(path, "-isrc.flac") {
			return isrc
		}
		return ""
	}

	waiting, err := m.Store.PendingMatchLoose(ctx, 10_000)
	if err != nil {
		t.Fatal(err)
	}
	var mine []MatchTrack
	for _, w := range waiting {
		switch w.ID {
		case personal:
			t.Fatal("a personal upload is waiting for a match")
		case fresh:
			t.Fatal("a track ingested moments ago is waiting for a match")
		case loose, bare:
			mine = append(mine, w)
		}
	}
	if len(mine) != 2 {
		t.Fatalf("waiting = %d of the test's loose tracks, want 2", len(mine))
	}
	for _, w := range mine {
		if err := m.matchLoose(ctx, w); err != nil {
			t.Fatal(err)
		}
	}
	got := f.state(loose)
	if got.Album != rel.Title || got.AlbumArtist != solo || got.Year != 1999 || got.TrackNo != 4 ||
		got.ISRC != isrc || got.TIDALAlbum != relID || got.Match != MatchMatched {
		t.Fatalf("loose = %+v; want it filed under the ISRC match's release", got)
	}
	if got := f.state(bare); got.Match != MatchUnmatched || got.Edited {
		t.Fatalf("bare = %+v; want it unmatched", got)
	}
	if got := f.state(personal); got.Match != "" || got.Album != "" {
		t.Fatalf("personal = %+v; want it untouched", got)
	}
}

func TestMatcherKeepsLinkedAlbum(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	main := "Main " + f.run
	relID := "rel" + f.run
	rel := tidal.Album{ID: relID, Title: "Original " + f.run, Artist: main, ReleaseYear: 2010,
		Tracks: []tidal.Track{{ID: "a" + f.run, Title: "Song", Artists: []string{main}, DurationMS: 150_000, TrackNo: 5, DiscNo: 1}}}
	if err := f.lib.SaveTIDALAlbum(ctx, rel); err != nil {
		t.Fatal(err)
	}
	// Auto-download linked the album to the release, then an admin renamed it.
	albumID := f.album("Renamed "+f.run, main, 2010)
	f.exec(`UPDATE albums SET tidal_album_id = $2 WHERE id = $1`, albumID, relID)
	song := f.track(localTrack{title: "song", artists: []string{main}, album: &albumID, duration: 150_000})
	extra := f.track(localTrack{title: "Extra", artists: []string{main}, album: &albumID, duration: 10_000})

	src := &fakeCatalog{err: errors.New("TIDAL must not be needed")}
	if err := f.matcher(src).matchAlbum(ctx, albumID); err != nil {
		t.Fatal(err)
	}
	got := f.state(song)
	if got.AlbumID != albumID || got.Title != "Song" || got.TrackNo != 5 || got.Year != 2010 || got.Match != MatchMatched {
		t.Fatalf("song = %+v; want TIDAL's metadata in its own album", got)
	}
	if got := f.state(extra); got.AlbumID != albumID || got.Match != MatchUnmatched {
		t.Fatalf("extra = %+v", got)
	}
}

func TestMatcherRecordsNothingWithoutTIDAL(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	main := "Main " + f.run
	albumID := f.album("Record "+f.run, main, 0)
	id := f.track(localTrack{title: "Song", artists: []string{main}, album: &albumID, duration: 100_000})
	loose := f.track(localTrack{title: "Loose", artists: []string{main}, duration: 100_000})
	src := &fakeCatalog{err: tidal.ErrNotConfigured}
	m := f.matcher(src)
	if err := m.matchAlbum(ctx, albumID); !errors.Is(err, tidal.ErrNotConfigured) {
		t.Fatalf("matchAlbum = %v", err)
	}
	if err := m.matchLoose(ctx, MatchTrack{ID: loose, Title: "Loose", Artists: []string{main}}); !errors.Is(err, tidal.ErrNotConfigured) {
		t.Fatalf("matchLoose = %v", err)
	}
	for _, tr := range []uuid.UUID{id, loose} {
		if got := f.state(tr); got.Match != "" {
			t.Fatalf("recorded %q without TIDAL", got.Match)
		}
	}

	// Other errors back off.
	src.err = errors.New("upstream 500")
	if err := m.matchAlbum(ctx, albumID); err == nil {
		t.Fatal("matchAlbum succeeded")
	}
	if got := f.state(id); got.Match != MatchFailed || got.Retry == nil || time.Until(*got.Retry) > 6*time.Minute {
		t.Fatalf("failure = %+v; want a 5 minute backoff", got)
	}
}

func containsID(ids []uuid.UUID, id uuid.UUID) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

// Search hits rarely name their album's artist, so a loose track's release
// is checked: a compilation gives way to the next hit's artist release.
func TestMatcherLooseTrackSkipsCompilationRelease(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	solo := "Solo " + f.run
	id := f.track(localTrack{title: "Anthem", artists: []string{solo}, duration: 210_000})
	compID, ownID := "comp"+f.run, "own"+f.run
	comp := tidal.Album{ID: compID, Title: "Now " + f.run, Artist: "Various Artists",
		Tracks: []tidal.Track{{ID: "c" + f.run, Title: "Anthem", Artists: []string{solo}, DurationMS: 210_000, TrackNo: 12}}}
	own := tidal.Album{ID: ownID, Title: "Anthems " + f.run, Artist: solo, ReleaseYear: 2015,
		Tracks: []tidal.Track{{ID: "o" + f.run, Title: "Anthem", Artists: []string{solo}, DurationMS: 210_000, TrackNo: 1}}}
	src := &fakeCatalog{
		searchTracks: []tidal.Track{
			{ID: "c" + f.run, Title: "Anthem", Artists: []string{solo}, DurationMS: 210_000, AlbumID: compID, AlbumTitle: comp.Title},
			// The compilation listed twice uses up one release check, not two.
			{ID: "c2" + f.run, Title: "Anthem", Artists: []string{solo}, DurationMS: 210_000, AlbumID: compID, AlbumTitle: comp.Title},
			{ID: "o" + f.run, Title: "Anthem", Artists: []string{solo}, DurationMS: 210_000, AlbumID: ownID, AlbumTitle: own.Title},
		},
		albums: map[string]tidal.Album{compID: comp, ownID: own},
	}
	if err := f.matcher(src).matchLoose(ctx, MatchTrack{ID: id, Title: "Anthem", Artists: []string{solo}, DurationMS: 210_000}); err != nil {
		t.Fatal(err)
	}
	if got := f.state(id); got.Album != own.Title || got.AlbumArtist != solo || got.TrackNo != 1 || got.Year != 2015 {
		t.Fatalf("track = %+v; want the artist's own release", got)
	}
	if _, _, err := f.lib.TIDALAlbum(ctx, compID); !errors.Is(err, library.ErrNotFound) {
		t.Fatalf("the skipped compilation was stored: %v", err)
	}
}

// A match is recorded in the transaction that applies it: if recording
// fails, the track is left as it was, to be tried again.
func TestApplyTIDALMatchRollsBackWithItsRecord(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	main := "Main " + f.run
	id := f.track(localTrack{title: "song", artists: []string{main}, duration: 100_000})
	applied, err := f.lib.ApplyTIDALMatch(ctx, id, library.TIDALTrackFields{
		Title: "Song", Artists: []string{main}, Album: library.TIDALAlbumFields{Title: "Record " + f.run, Artist: main},
	}, func(context.Context, pgx.Tx, *uuid.UUID) error { return errors.New("record failed") })
	if err == nil || applied {
		t.Fatalf("applied = %v, err = %v; want the record's error", applied, err)
	}
	if got := f.state(id); got.Title != "song" || got.Edited || got.Album != "" {
		t.Fatalf("track = %+v; want it unchanged", got)
	}
}

// A release cover that can't be fetched when its track is matched is
// retried later, until the album has it.
func TestMatcherRetriesReleaseCover(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	main := "Main " + f.run
	id := f.track(localTrack{title: "Song", artists: []string{main}, duration: 100_000})
	relID := "rel" + f.run
	rel := tidal.Album{ID: relID, Title: "Record " + f.run, Artist: main, CoverURL: "https://resources.tidal.com/x.jpg",
		Tracks: []tidal.Track{{ID: "a" + f.run, Title: "Song", Artists: []string{main}, DurationMS: 100_000, TrackNo: 1}}}
	src := &fakeCatalog{
		searchTracks: []tidal.Track{{ID: "a" + f.run, Title: "Song", Artists: []string{main}, DurationMS: 100_000, AlbumID: relID}},
		albums:       map[string]tidal.Album{relID: rel},
	}
	root := t.TempDir()
	m := f.matcher(src)
	m.Ingest = &ingest.Service{DB: f.pool, Library: f.lib, Storage: storage.NewLocal(root), MusicRoot: root}
	if err := m.matchLoose(ctx, MatchTrack{ID: id, Title: "Song", Artists: []string{main}, DurationMS: 100_000}); err != nil {
		t.Fatal(err)
	}
	coverOf := func() string {
		var cover string
		if err := f.pool.QueryRow(ctx, `
			SELECT COALESCE(a.cover_art_path, '') FROM tracks t JOIN albums a ON a.id = t.album_id
			WHERE t.id = $1`, id).Scan(&cover); err != nil {
			t.Fatal(err)
		}
		return cover
	}
	if got := f.state(id); got.Match != MatchMatched || coverOf() != "" {
		t.Fatalf("track = %+v, cover %q; want a match still waiting for its cover", got, coverOf())
	}
	pending, err := m.Store.PendingCovers(ctx, 1000)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range pending {
		if c.TrackID == id {
			t.Fatal("a cover that just failed is due again at once")
		}
	}

	// Due again in a later pass, and TIDAL serves it this time.
	m.coverMissed = nil
	f.exec(`UPDATE tidal_matches SET cover_retry_at = NOW() WHERE track_id = $1`, id)
	src.cover = func() ([]byte, error) {
		var buf bytes.Buffer
		if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 4, 4))); err != nil {
			return nil, err
		}
		return buf.Bytes(), nil
	}
	m.backfillCovers(ctx)
	if coverOf() == "" {
		t.Fatal("the album still has no cover")
	}
	var left string
	if err := f.pool.QueryRow(ctx, `SELECT cover_url FROM tidal_matches WHERE track_id = $1`, id).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != "" {
		t.Fatalf("cover still pending: %q", left)
	}

	// A retried cover goes to the album the match filed the track under,
	// even after the track has moved.
	id2 := f.track(localTrack{title: "Other", artists: []string{main}, duration: 90_000})
	rel2ID := "rel2" + f.run
	rel2 := tidal.Album{ID: rel2ID, Title: "Second " + f.run, Artist: main, CoverURL: "https://resources.tidal.com/y.jpg",
		Tracks: []tidal.Track{{ID: "b" + f.run, Title: "Other", Artists: []string{main}, DurationMS: 90_000}}}
	src.albums[rel2ID] = rel2
	src.searchTracks = []tidal.Track{{ID: "b" + f.run, Title: "Other", Artists: []string{main}, DurationMS: 90_000, AlbumID: rel2ID}}
	working := src.cover
	src.cover = nil
	if err := m.matchLoose(ctx, MatchTrack{ID: id2, Title: "Other", Artists: []string{main}, DurationMS: 90_000}); err != nil {
		t.Fatal(err)
	}
	matched := f.state(id2).AlbumID
	elsewhere := f.album("Elsewhere "+f.run, main, 0)
	f.exec(`UPDATE tracks SET album_id = $2 WHERE id = $1`, id2, elsewhere)
	f.exec(`UPDATE tidal_matches SET cover_retry_at = NOW() WHERE track_id = $1`, id2)
	m.coverMissed = nil
	src.cover = working
	m.backfillCovers(ctx)
	var matchedCover, elsewhereCover string
	if err := f.pool.QueryRow(ctx, `
		SELECT COALESCE((SELECT cover_art_path FROM albums WHERE id = $1), ''),
		       COALESCE((SELECT cover_art_path FROM albums WHERE id = $2), '')`, matched, elsewhere).
		Scan(&matchedCover, &elsewhereCover); err != nil {
		t.Fatal(err)
	}
	if matchedCover == "" || elsewhereCover != "" {
		t.Fatalf("matched album cover %q, other album %q; want only the matched album filled", matchedCover, elsewhereCover)
	}
}

// An "album" too large for any release is a folder: none of its tracks are
// matched, however many are still waiting.
func TestMatcherSkipsOversizedAlbum(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	main := "Main " + f.run
	albumID := f.album("Downloads "+f.run, "", 0)
	for i := 0; i <= matchMaxAlbumTracks; i++ {
		f.track(localTrack{title: "Track", artists: []string{main}, album: &albumID, duration: 100_000})
	}
	m := f.matcher(&fakeCatalog{err: errors.New("TIDAL must not be asked")})
	for pass := 0; pass < 2; pass++ {
		if err := m.matchAlbum(ctx, albumID); err != nil {
			t.Fatal(err)
		}
	}
	var unmatched, other int
	if err := f.pool.QueryRow(ctx, `
		SELECT COUNT(*) FILTER (WHERE m.status = 'unmatched'), COUNT(*) FILTER (WHERE m.status IS DISTINCT FROM 'unmatched')
		FROM tracks t LEFT JOIN tidal_matches m ON m.track_id = t.id
		WHERE t.album_id = $1`, albumID).Scan(&unmatched, &other); err != nil {
		t.Fatal(err)
	}
	if unmatched != matchMaxAlbumTracks+1 || other != 0 {
		t.Fatalf("%d unmatched, %d otherwise; want all %d unmatched", unmatched, other, matchMaxAlbumTracks+1)
	}
}

// Importer tracks carry the importer's metadata, even when it predates the
// edited marker.
func TestMatcherSkipsImporterTracks(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	main := "Main " + f.run
	id := f.track(localTrack{title: "Leak", artists: []string{main}, duration: 100_000})
	pin := uuid.New()
	f.exec(`INSERT INTO api_tracker_pins(id, root_path, tracker_id) VALUES($1, '/music', 1)`, pin)
	t.Cleanup(func() { f.pool.Exec(context.Background(), `DELETE FROM api_tracker_pins WHERE id = $1`, pin) })
	f.exec(`INSERT INTO api_tracker_downloads(pin_id, source_url, status, track_id) VALUES($1, $2, 'downloaded', $3)`,
		pin, "https://example.com/"+f.run, id)
	waiting, err := NewStore(f.pool).PendingMatchLoose(ctx, 10_000)
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range waiting {
		if w.ID == id {
			t.Fatal("an importer's track is waiting for a match")
		}
	}
}

// A loose track keeps the hit with its own ISRC, compilation or not, over a
// weaker hit on the artist's release.
func TestMatcherLooseTrackKeepsISRCHit(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	solo := "Solo " + f.run
	isrc := "GBAYE0600002"
	id := f.track(localTrack{title: "Anthem", artists: []string{solo}, duration: 210_000, isrc: isrc})
	compID, ownID := "comp"+f.run, "own"+f.run
	comp := tidal.Album{ID: compID, Title: "Now " + f.run, Artist: "Various Artists",
		Tracks: []tidal.Track{{ID: "c" + f.run, Title: "Anthem", Artists: []string{solo}, DurationMS: 210_000, ISRC: isrc}}}
	own := tidal.Album{ID: ownID, Title: "Anthems " + f.run, Artist: solo,
		Tracks: []tidal.Track{{ID: "o" + f.run, Title: "Anthem", Artists: []string{solo}, DurationMS: 210_000, ISRC: "GBAYE0600003"}}}
	src := &fakeCatalog{
		searchTracks: []tidal.Track{
			{ID: "o" + f.run, Title: "Anthem", Artists: []string{solo}, DurationMS: 210_000, ISRC: "GBAYE0600003", AlbumID: ownID},
			{ID: "c" + f.run, Title: "Anthem", Artists: []string{solo}, DurationMS: 210_000, ISRC: isrc, AlbumID: compID},
		},
		albums: map[string]tidal.Album{compID: comp, ownID: own},
	}
	if err := f.matcher(src).matchLoose(ctx, MatchTrack{ID: id, Title: "Anthem", Artists: []string{solo},
		DurationMS: 210_000, ISRC: isrc}); err != nil {
		t.Fatal(err)
	}
	if got := f.state(id); got.Album != comp.Title || got.ISRC != isrc {
		t.Fatalf("track = %+v; want the ISRC hit's release", got)
	}
}

// An attempt cut short after choosing a release finishes on that release,
// even though the tracks left can't vouch for it themselves.
func TestMatcherFinishesInterruptedAlbum(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	main := "Main " + f.run
	relID := "rel" + f.run
	rel := tidal.Album{ID: relID, Title: "Record " + f.run, Artist: main, ReleaseYear: 2004,
		Tracks: []tidal.Track{{ID: "a" + f.run, Title: "Song", Artists: []string{main}, DurationMS: 100_000, TrackNo: 1}}}
	if err := f.lib.SaveTIDALAlbum(ctx, rel); err != nil {
		t.Fatal(err)
	}
	albumID := f.album("Record "+f.run, "", 0)
	bonus := f.track(localTrack{title: "Bonus", artists: []string{main}, album: &albumID, duration: 50_000})
	f.exec(`INSERT INTO tidal_match_albums(album_id, tidal_album_id) VALUES($1, $2)`, albumID, relID)

	src := &fakeCatalog{err: errors.New("TIDAL must not be needed")}
	if err := f.matcher(src).matchAlbum(ctx, albumID); err != nil {
		t.Fatal(err)
	}
	if got := f.state(bonus); got.Album != rel.Title || got.AlbumArtist != main || got.Match != MatchUnmatched ||
		got.MatchAlbum != relID {
		t.Fatalf("bonus = %+v; want it filed under the release chosen before", got)
	}
	var left int
	if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM tidal_match_albums WHERE album_id = $1`, albumID).Scan(&left); err != nil || left != 0 {
		t.Fatalf("album choice left behind: %d, %v", left, err)
	}
}

// Tracks of an album an admin edited stay where the admin put them.
func TestMatcherLeavesEditedAlbum(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	main := "Main " + f.run
	albumID := f.album("Record "+f.run, main, 0)
	f.track(localTrack{title: "Song", artists: []string{main}, album: &albumID, duration: 100_000})
	store := NewStore(f.pool)
	pending, err := store.PendingMatchAlbums(ctx, 10_000)
	if err != nil {
		t.Fatal(err)
	}
	if !containsID(pending, albumID) {
		t.Fatal("album isn't pending before the edit")
	}
	title := "Record " + f.run + " (My Edition)"
	if err := f.lib.UpdateAlbum(ctx, albumID, library.AlbumPatch{Title: &title}); err != nil {
		t.Fatal(err)
	}
	if pending, err = store.PendingMatchAlbums(ctx, 10_000); err != nil {
		t.Fatal(err)
	}
	if containsID(pending, albumID) {
		t.Fatal("an album an admin edited is pending")
	}

	// Personal uploads in the album don't count toward its size.
	owner := uuid.New()
	f.exec(`INSERT INTO users(id, username, password_hash, role) VALUES($1, $2, 'x', 'user')`, owner, "match-"+f.run)
	other := f.album("Other "+f.run, main, 0)
	f.track(localTrack{title: "Shared", artists: []string{main}, album: &other, duration: 100_000})
	for i := 0; i < 3; i++ {
		f.track(localTrack{title: "Mine", artists: []string{main}, album: &other, duration: 100_000, owner: &owner})
	}
	if a, _, err := store.MatchAlbumTracks(ctx, other, 10); err != nil || a.Tracks != 1 {
		t.Fatalf("album counts %d tracks (%v); want only the shared one", a.Tracks, err)
	}
}

// A release whose library album (same title and artist) is linked to another
// release can't take the track: it would follow that release.
func TestMatcherRefusesAlbumLinkedElsewhere(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	solo := "Solo " + f.run
	title := "Reissue " + f.run
	taken := f.album(title, solo, 0)
	f.exec(`UPDATE albums SET tidal_album_id = $2 WHERE id = $1`, taken, "other"+f.run)
	id := f.track(localTrack{title: "Song", artists: []string{solo}, duration: 100_000})
	relID := "rel" + f.run
	rel := tidal.Album{ID: relID, Title: title, Artist: solo,
		Tracks: []tidal.Track{{ID: "a" + f.run, Title: "Song", Artists: []string{solo}, DurationMS: 100_000}}}
	src := &fakeCatalog{
		searchTracks: []tidal.Track{{ID: "a" + f.run, Title: "Song", Artists: []string{solo}, DurationMS: 100_000, AlbumID: relID}},
		albums:       map[string]tidal.Album{relID: rel},
	}
	if err := f.matcher(src).matchLoose(ctx, MatchTrack{ID: id, Title: "Song", Artists: []string{solo}, DurationMS: 100_000}); err != nil {
		t.Fatal(err)
	}
	if got := f.state(id); got.Album != "" || got.Edited || got.Match != MatchUnmatched {
		t.Fatalf("track = %+v; want it left as it was, unmatched", got)
	}
}

// An admin's album edit that lands while a match is being looked up wins.
func TestApplyTIDALMatchHonorsAlbumEdit(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	main := "Main " + f.run
	albumID := f.album("Record "+f.run, main, 0)
	id := f.track(localTrack{title: "song", artists: []string{main}, album: &albumID, duration: 100_000})
	year := 1999
	if err := f.lib.UpdateAlbum(ctx, albumID, library.AlbumPatch{ReleaseYear: &year}); err != nil {
		t.Fatal(err)
	}
	applied, err := f.lib.ApplyTIDALMatch(ctx, id, library.TIDALTrackFields{
		Title: "Song", From: &albumID, Album: library.TIDALAlbumFields{Title: "Elsewhere " + f.run, Artist: main},
	}, nil)
	if err != nil || applied {
		t.Fatalf("applied = %v, %v; want the edited album to keep its track", applied, err)
	}
	if got := f.state(id); got.AlbumID != albumID || got.Title != "song" {
		t.Fatalf("track = %+v", got)
	}
}

// An album waits while any of its waiting tracks is still settling, so it is
// judged whole.
func TestMatcherWaitsForAlbumToSettle(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	main := "Main " + f.run
	albumID := f.album("Record "+f.run, main, 0)
	old := f.track(localTrack{title: "Old", artists: []string{main}, album: &albumID, duration: 100_000})
	f.track(localTrack{title: "New", artists: []string{main}, album: &albumID, duration: 100_000, fresh: true})
	store := NewStore(f.pool)
	pending, err := store.PendingMatchAlbums(ctx, 10_000)
	if err != nil {
		t.Fatal(err)
	}
	if containsID(pending, albumID) {
		t.Fatal("an album with a track still settling is pending")
	}
	if err := f.matcher(&fakeCatalog{err: errors.New("TIDAL must not be asked")}).matchAlbum(ctx, albumID); err != nil {
		t.Fatal(err)
	}
	if got := f.state(old); got.Match != "" {
		t.Fatalf("old = %+v; want it left for when the album settles", got)
	}
}

// Track searches go on past the threshold while they may find a release
// listing more of the album.
func TestMatcherPrefersFullerReleaseFromTrackSearch(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	main := "Main " + f.run
	title := "Record " + f.run
	albumID := f.album(title, main, 0)
	names := []string{"One", "Two", "Three"}
	var ids []uuid.UUID
	for i, n := range names {
		ids = append(ids, f.track(localTrack{title: n, artists: []string{main}, album: &albumID,
			duration: 100_000 + i*10_000, trackNo: i + 1}))
	}
	entry := func(id, name string, i int) tidal.Track {
		return tidal.Track{ID: id, Title: name, Artists: []string{main}, DurationMS: 100_000 + i*10_000, TrackNo: i + 1}
	}
	shortID, fullID := "short"+f.run, "full"+f.run
	short := tidal.Album{ID: shortID, Title: title + " (Edited)", Artist: main,
		Tracks: []tidal.Track{entry("s1"+f.run, "One", 0), entry("s2"+f.run, "Two", 1)}}
	full := tidal.Album{ID: fullID, Title: title + " (Deluxe)", Artist: main,
		Tracks: []tidal.Track{entry("f1"+f.run, "One", 0), entry("f2"+f.run, "Two", 1), entry("f3"+f.run, "Three", 2)}}
	hit := func(name string, i int, a tidal.Album) []tidal.Track {
		h := entry("x", name, i)
		h.AlbumID, h.AlbumTitle = a.ID, a.Title
		return []tidal.Track{h}
	}
	src := &fakeCatalog{
		byQuery: map[string][]tidal.Track{
			main + " One":   hit("One", 0, short),
			main + " Three": hit("Three", 2, full),
		},
		albums: map[string]tidal.Album{shortID: short, fullID: full},
	}
	if err := f.matcher(src).matchAlbum(ctx, albumID); err != nil {
		t.Fatal(err)
	}
	for _, id := range ids {
		if got := f.state(id); got.TIDALAlbum != fullID {
			t.Fatalf("track = %+v; want every track on the release listing all three", got)
		}
	}
}

// A track moved out of the album a match was decided for is left alone.
func TestApplyTIDALMatchNeedsSourceAlbum(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	main := "Main " + f.run
	from := f.album("Record "+f.run, main, 0)
	moved := f.album("Moved "+f.run, main, 0)
	id := f.track(localTrack{title: "song", artists: []string{main}, album: &moved, duration: 100_000})
	applied, err := f.lib.ApplyTIDALMatch(ctx, id, library.TIDALTrackFields{
		Title: "Song", From: &from, Album: library.TIDALAlbumFields{Title: "Elsewhere " + f.run, Artist: main},
	}, nil)
	if err != nil || applied {
		t.Fatalf("applied = %v, %v; want a moved track left alone", applied, err)
	}
	filed, err := f.lib.FileUnderTIDALRelease(ctx, id, &from, nil, library.TIDALAlbumFields{Title: "Elsewhere " + f.run, Artist: main})
	if err != nil || filed {
		t.Fatalf("filed = %v, %v; want a moved track left alone", filed, err)
	}
	if got := f.state(id); got.AlbumID != moved || got.Title != "song" {
		t.Fatalf("track = %+v", got)
	}
}

// An album's chosen release stays noted while one of its tracks still
// has to be filed (a failure to retry), and goes once none has. A track
// backing off is taken along with its album rather than left behind.
func TestMatcherKeepsChoiceWhileTrackBacksOff(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	main := "Main " + f.run
	relID := "rel" + f.run
	rel := tidal.Album{ID: relID, Title: "Record " + f.run, Artist: main,
		Tracks: []tidal.Track{{ID: "a" + f.run, Title: "Song", Artists: []string{main}, DurationMS: 100_000, TrackNo: 1}}}
	if err := f.lib.SaveTIDALAlbum(ctx, rel); err != nil {
		t.Fatal(err)
	}
	albumID := f.album("Record "+f.run, "", 0)
	failed := f.track(localTrack{title: "Song", artists: []string{main}, album: &albumID, duration: 100_000})
	tail := f.track(localTrack{title: "Bonus", artists: []string{main}, album: &albumID, duration: 50_000})
	store := NewStore(f.pool)
	if err := store.ChooseRelease(ctx, albumID, relID); err != nil {
		t.Fatal(err)
	}
	f.exec(`INSERT INTO tidal_matches(track_id, status, error, attempts, next_attempt_at)
	        VALUES($1, 'failed', 'db hiccup', 1, NOW() + INTERVAL '5 minutes'),
	              ($2, 'unmatched', '', 1, NOW() + INTERVAL '30 days')`, failed, tail)
	choices := func() int {
		var n int
		if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM tidal_match_albums WHERE album_id = $1`, albumID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if err := store.ReleaseDone(ctx, albumID); err != nil {
		t.Fatal(err)
	}
	if choices() != 1 {
		t.Fatal("the choice went while a track still had to be filed")
	}

	// A new track brings the album up; the backing-off track comes along.
	f.track(localTrack{title: "Extra", artists: []string{main}, album: &albumID, duration: 70_000})
	m := f.matcher(&fakeCatalog{err: errors.New("TIDAL must not be needed")})
	if err := m.matchAlbum(ctx, albumID); err != nil {
		t.Fatal(err)
	}
	if got := f.state(failed); got.Match != MatchMatched || got.Album != rel.Title {
		t.Fatalf("failed track = %+v; want it matched on the chosen release", got)
	}
	if got := f.state(tail); got.Album != rel.Title {
		t.Fatalf("tail = %+v; want it filed with the rest", got)
	}
	if choices() != 0 {
		t.Fatal("the choice outlived the album")
	}
}

// A track added to an album whose other tracks found no match is judged
// with them, not on its own.
func TestMatcherJudgesNewTrackWithRestingAlbum(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	main := "Main " + f.run
	title := "Record " + f.run
	albumID := f.album(title, main, 0)
	var resting []uuid.UUID
	for i, n := range []string{"One", "Two"} {
		id := f.track(localTrack{title: n, artists: []string{main}, album: &albumID, duration: 100_000 + i*10_000})
		f.exec(`INSERT INTO tidal_matches(track_id, status, attempts, next_attempt_at)
		        VALUES($1, 'unmatched', 1, NOW() + INTERVAL '20 days')`, id)
		resting = append(resting, id)
	}
	fresh := f.track(localTrack{title: "Three", artists: []string{main}, album: &albumID, duration: 130_000})
	relID := "rel" + f.run
	rel := tidal.Album{ID: relID, Title: title + " (Single)", Artist: main,
		Tracks: []tidal.Track{{ID: "a" + f.run, Title: "Three", Artists: []string{main}, DurationMS: 130_000}}}
	src := &fakeCatalog{searchAlbums: []tidal.Album{rel}, albums: map[string]tidal.Album{relID: rel}}
	store := NewStore(f.pool)
	pending, err := store.PendingMatchAlbums(ctx, 10_000)
	if err != nil {
		t.Fatal(err)
	}
	if !containsID(pending, albumID) {
		t.Fatal("album with a new track isn't pending")
	}
	if err := f.matcher(src).matchAlbum(ctx, albumID); err != nil {
		t.Fatal(err)
	}
	for _, id := range append(resting, fresh) {
		if got := f.state(id); got.AlbumID != albumID || got.Match != MatchUnmatched {
			t.Fatalf("track = %+v; want the album kept together and unmatched", got)
		}
	}

	// An edit ends a track's retries, and the counts follow.
	before, err := store.MatchSummary(ctx)
	if err != nil {
		t.Fatal(err)
	}
	newTitle := "One (edited)"
	if err := f.lib.UpdateTrack(ctx, resting[0], library.TrackPatch{Title: &newTitle}); err != nil {
		t.Fatal(err)
	}
	after, err := store.MatchSummary(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if after.Unmatched != before.Unmatched-1 {
		t.Fatalf("unmatched %d → %d; an edited track still counts", before.Unmatched, after.Unmatched)
	}
}

// A track changed while its match was looked up (say a duplicate's tags were
// adopted) is left for a fresh look.
func TestApplyTIDALMatchNeedsUnchangedTrack(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	main := "Main " + f.run
	id := f.track(localTrack{title: "song", artists: []string{main}, duration: 100_000})
	seen := time.Now().Add(-2 * time.Hour)
	applied, err := f.lib.ApplyTIDALMatch(ctx, id, library.TIDALTrackFields{
		Title: "Song", Seen: &seen, Album: library.TIDALAlbumFields{Title: "Record " + f.run, Artist: main},
	}, nil)
	if err != nil || applied {
		t.Fatalf("applied = %v, %v; want a changed track left alone", applied, err)
	}
}

// A release whose library album an admin edited can't take tracks, and one
// album's failing cover is fetched once a pass, not once per track.
func TestMatcherEditedDestinationAndCoverOncePerAlbum(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	solo := "Solo " + f.run
	edited := f.album("Kept "+f.run, solo, 0)
	year := 2000
	if err := f.lib.UpdateAlbum(ctx, edited, library.AlbumPatch{ReleaseYear: &year}); err != nil {
		t.Fatal(err)
	}
	loose := f.track(localTrack{title: "Song", artists: []string{solo}, duration: 100_000})
	keptID := "kept" + f.run
	kept := tidal.Album{ID: keptID, Title: "Kept " + f.run, Artist: solo,
		Tracks: []tidal.Track{{ID: "k" + f.run, Title: "Song", Artists: []string{solo}, DurationMS: 100_000}}}
	src := &fakeCatalog{
		searchTracks: []tidal.Track{{ID: "k" + f.run, Title: "Song", Artists: []string{solo}, DurationMS: 100_000, AlbumID: keptID}},
		albums:       map[string]tidal.Album{keptID: kept},
	}
	m := f.matcher(src)
	if err := m.matchLoose(ctx, MatchTrack{ID: loose, Title: "Song", Artists: []string{solo}, DurationMS: 100_000}); err != nil {
		t.Fatal(err)
	}
	if got := f.state(loose); got.Album != "" || got.Match != MatchUnmatched {
		t.Fatalf("loose = %+v; want it kept out of the edited album", got)
	}

	main := "Main " + f.run
	albumID := f.album("Record "+f.run, main, 0)
	for i, n := range []string{"One", "Two", "Three"} {
		f.track(localTrack{title: n, artists: []string{main}, album: &albumID, duration: 100_000 + i*10_000})
	}
	relID := "rel" + f.run
	rel := tidal.Album{ID: relID, Title: "Record " + f.run, Artist: main, CoverURL: "https://resources.tidal.com/z.jpg"}
	for i, n := range []string{"One", "Two", "Three"} {
		rel.Tracks = append(rel.Tracks, tidal.Track{ID: n + f.run, Title: n, Artists: []string{main}, DurationMS: 100_000 + i*10_000})
	}
	src.searchAlbums = []tidal.Album{rel}
	src.albums[relID] = rel
	root := t.TempDir()
	m.Ingest = &ingest.Service{DB: f.pool, Library: f.lib, Storage: storage.NewLocal(root), MusicRoot: root}
	if err := m.matchAlbum(ctx, albumID); err != nil {
		t.Fatal(err)
	}
	if src.coverCalls != 1 {
		t.Fatalf("fetched the failing cover %d times; want once for the album", src.coverCalls)
	}
	pending, err := m.Store.PendingCovers(ctx, 10_000)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range pending {
		var album uuid.UUID
		if err := f.pool.QueryRow(ctx, `SELECT COALESCE(album_id, '00000000-0000-0000-0000-000000000000'::uuid) FROM tracks WHERE id = $1`, c.TrackID).Scan(&album); err == nil && c.AlbumID != nil && *c.AlbumID == album {
			var title string
			_ = f.pool.QueryRow(ctx, `SELECT title FROM albums WHERE id = $1`, album).Scan(&title)
			if title == rel.Title {
				t.Fatal("a track's cover is due again right after the album's failed")
			}
		}
	}
}

// An outcome decided on a track as loaded isn't recorded for a track moved
// or changed since, and an outcome from before an album's release choice
// doesn't finish the choice.
func TestOutcomesNeedTheTrackAsLoaded(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	main := "Main " + f.run
	albumID := f.album("Record "+f.run, main, 0)
	other := f.album("Other "+f.run, main, 0)
	stays := f.track(localTrack{title: "Stays", artists: []string{main}, album: &albumID, duration: 100_000})
	moves := f.track(localTrack{title: "Moves", artists: []string{main}, album: &albumID, duration: 100_000})
	store := NewStore(f.pool)
	_, loaded, err := store.MatchAlbumTracks(ctx, albumID, 10)
	if err != nil || len(loaded) != 2 {
		t.Fatalf("loaded %d tracks, %v", len(loaded), err)
	}
	f.exec(`UPDATE tracks SET album_id = $2 WHERE id = $1`, moves, other)
	m := f.matcher(&fakeCatalog{})
	m.recordAll(ctx, loaded, MatchOutcome{Status: MatchUnmatched, Error: "none"}, nil)
	if got := f.state(stays); got.Match != MatchUnmatched {
		t.Fatalf("stays = %+v", got)
	}
	if got := f.state(moves); got.Match != "" {
		t.Fatalf("moved track got outcome %q decided for its old album", got.Match)
	}

	// The choice comes after stays' outcome, which then doesn't finish it.
	f.exec(`INSERT INTO tidal_match_albums(album_id, tidal_album_id, created_at) VALUES($1, 'rel', NOW() + INTERVAL '1 second')`, albumID)
	if err := store.ReleaseDone(ctx, albumID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM tidal_match_albums WHERE album_id = $1`, albumID).Scan(&n); err != nil || n != 1 {
		t.Fatalf("choice count %d, %v; an outcome older than the choice finished it", n, err)
	}
}

// A track leaving the catch-all doesn't take its cover, which came from
// whichever untagged file had art first.
func TestCatchAllCoverStaysBehind(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	main := "Main " + f.run
	var others uuid.UUID
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO albums(title, is_compilation, cover_art_path) VALUES($1, TRUE, 'covers/unrelated.jpg')
		ON CONFLICT (title, COALESCE(album_artist_id, '00000000-0000-0000-0000-000000000000'::uuid))
		DO UPDATE SET cover_art_path = EXCLUDED.cover_art_path
		RETURNING id`, library.CatchAllAlbum).Scan(&others); err != nil {
		t.Fatal(err)
	}
	id := f.track(localTrack{title: "Untagged", album: &others, duration: 100_000})
	applied, err := f.lib.ApplyTIDALMatch(ctx, id, library.TIDALTrackFields{
		Title: "Song", Artists: []string{main}, From: &others,
		Album: library.TIDALAlbumFields{Title: "Record " + f.run, Artist: main},
	}, nil)
	if err != nil || !applied {
		t.Fatalf("applied = %v, %v", applied, err)
	}
	var cover string
	if err := f.pool.QueryRow(ctx, `
		SELECT COALESCE(a.cover_art_path, '') FROM tracks t JOIN albums a ON a.id = t.album_id WHERE t.id = $1`, id).
		Scan(&cover); err != nil {
		t.Fatal(err)
	}
	if cover != "" {
		t.Fatalf("release album took the catch-all's cover %q", cover)
	}
}

// A track that changed after its no-match (a duplicate's tags adopted, an
// ISRC filled) is due again, not left resting on the old decision.
func TestChangedTrackIsDueAgain(t *testing.T) {
	f := newMatchFixture(t)
	ctx := context.Background()
	main := "Main " + f.run
	id := f.track(localTrack{title: "Loose", artists: []string{main}, duration: 100_000})
	f.exec(`INSERT INTO tidal_matches(track_id, status, attempts, next_attempt_at, updated_at)
	        VALUES($1, 'unmatched', 1, NOW() + INTERVAL '20 days', NOW() - INTERVAL '50 minutes')`, id)
	store := NewStore(f.pool)
	waiting := func() bool {
		ts, err := store.PendingMatchLoose(ctx, 10_000)
		if err != nil {
			t.Fatal(err)
		}
		for _, w := range ts {
			if w.ID == id {
				return true
			}
		}
		return false
	}
	if waiting() {
		t.Fatal("a resting track is waiting")
	}
	f.exec(`UPDATE tracks SET updated_at = NOW() - INTERVAL '20 minutes' WHERE id = $1`, id)
	if !waiting() {
		t.Fatal("a track changed since its no-match isn't waiting")
	}
}
