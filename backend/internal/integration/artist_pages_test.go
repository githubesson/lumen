package integration

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubesson/lumen/internal/library"
)

// pageArtist inserts an artist with a name unique to the test run.
func pageArtist(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO artists(id,name) VALUES($1,$2)`, id, name+" "+id.String()[:8]); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM artists WHERE id=$1`, id) })
	return id
}

// credit links a track to its artists, the first primary and the rest
// featured, in order.
func credit(t *testing.T, ctx context.Context, pool *pgxpool.Pool, track uuid.UUID, artists ...uuid.UUID) {
	t.Helper()
	for i, artist := range artists {
		role := "featured"
		if i == 0 {
			role = "primary"
		}
		if _, err := pool.Exec(ctx, `INSERT INTO track_artists(track_id,artist_id,role,position) VALUES($1,$2,$3,$4)`,
			track, artist, role, i); err != nil {
			t.Fatal(err)
		}
	}
}

// tidalPlay materializes a TIDAL track the way playing one does: a hidden
// copy (library_visible = FALSE) that still credits its artists.
func tidalPlay(t *testing.T, ctx context.Context, pool *pgxpool.Pool, lib *library.Store, artists ...string) uuid.UUID {
	t.Helper()
	id, err := lib.UpsertRemoteTrack(ctx, library.RemoteTrackInput{
		Source: "tidal", ExternalID: "page-" + uuid.NewString(), Title: "Streamed", ArtistNames: artists, DurationMS: 1000,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM tracks WHERE id=$1`, id) })
	var visible bool
	if err := pool.QueryRow(ctx, `SELECT library_visible FROM tracks WHERE id=$1`, id).Scan(&visible); err != nil || visible {
		t.Fatalf("TIDAL play copy visible=%v: %v", visible, err)
	}
	return id
}

// hasPage asks the artist page itself.
func hasPage(t *testing.T, ctx context.Context, lib *library.Store, artist, viewer uuid.UUID) bool {
	t.Helper()
	_, err := lib.GetArtist(ctx, artist, viewer)
	if err != nil && !errors.Is(err, library.ErrNotFound) {
		t.Fatal(err)
	}
	return err == nil
}

func artistName(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id uuid.UUID) string {
	t.Helper()
	var name string
	if err := pool.QueryRow(ctx, `SELECT name FROM artists WHERE id=$1`, id).Scan(&name); err != nil {
		t.Fatal(err)
	}
	return name
}

// Replay counts plays of every track, TIDAL copies included, but only an
// artist with a library track the viewer can see has a page. Each top
// artist, and each top track's artist, says which, by the page's own test.
func TestReplayArtistsSayWhetherTheyHaveAPage(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	viewer, other := redteamUser(t, ctx, pool), redteamUser(t, ctx, pool)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}

	// In the library, and also on a TIDAL play with an artist streamed only.
	local := pageArtist(t, ctx, pool, "Local")
	credit(t, ctx, pool, redteamTrack(t, ctx, pool, nil, nil), local)
	streamedName := "Earth, Wind & Streamed " + uuid.NewString()[:8]
	duet := tidalPlay(t, ctx, pool, lib, streamedName)
	var streamed uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT artist_id FROM track_artists WHERE track_id=$1`, duet).Scan(&streamed); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM artists WHERE id=$1`, streamed) })
	exec(`INSERT INTO track_artists(track_id,artist_id,role,position) VALUES($1,$2,'primary',1)`, duet, local)
	// Only on another user's private upload, besides a TIDAL play: that page
	// is theirs to see, not the viewer's.
	private := pageArtist(t, ctx, pool, "Private")
	credit(t, ctx, pool, redteamTrack(t, ctx, pool, &other, nil), private)
	privatePlay := tidalPlay(t, ctx, pool, lib, artistName(t, ctx, pool, private))
	// Only on a deleted library track, besides a TIDAL play.
	gone := pageArtist(t, ctx, pool, "Gone")
	deleted := redteamTrack(t, ctx, pool, nil, nil)
	credit(t, ctx, pool, deleted, gone)
	exec(`UPDATE tracks SET deleted_at=NOW() WHERE id=$1`, deleted)
	gonePlay := tidalPlay(t, ctx, pool, lib, artistName(t, ctx, pool, gone))
	// Featured on a library track: a page lists every role.
	guest := pageArtist(t, ctx, pool, "Guest")
	credit(t, ctx, pool, redteamTrack(t, ctx, pool, nil, nil), pageArtist(t, ctx, pool, "Host"), guest)
	guestPlay := tidalPlay(t, ctx, pool, lib, artistName(t, ctx, pool, guest))

	at := time.Date(2024, 3, 1, 12, 0, 0, 0, time.UTC)
	for plays, track := range []uuid.UUID{privatePlay, gonePlay, guestPlay, duet} {
		for range plays + 1 {
			exec(`INSERT INTO play_history(user_id,track_id,played_at) VALUES($1,$2,$3)`, viewer, track, at)
		}
	}

	data, err := lib.ReplayStats(ctx, library.ReplayStatsParams{ViewerID: viewer})
	if err != nil {
		t.Fatal(err)
	}
	want := map[uuid.UUID]bool{local: true, streamed: false, private: false, gone: false, guest: true}
	if len(data.TopArtists) != len(want) {
		t.Fatalf("top artists = %+v", data.TopArtists)
	}
	for _, a := range data.TopArtists {
		page, ok := want[a.ID]
		if !ok || a.HasPage != page || hasPage(t, ctx, lib, a.ID, viewer) != page {
			t.Errorf("%s: has_page=%v, want %v (known=%v)", a.Name, a.HasPage, page, ok)
		}
	}
	// The other user does see their own upload's artist.
	if !hasPage(t, ctx, lib, private, other) {
		t.Error("the uploader lost their artist's page")
	}

	// The duet's artists, by id and in order, though one name has a comma.
	var top *library.ReplayTrack
	for i := range data.TopTracks {
		if data.TopTracks[i].ID == duet {
			top = &data.TopTracks[i]
		}
	}
	if top == nil {
		t.Fatalf("top tracks = %+v", data.TopTracks)
	}
	got := top.PrimaryArtists
	if len(got) != 2 || got[0].ID != streamed || got[0].Name != streamedName || got[0].HasPage ||
		got[1].ID != local || !got[1].HasPage || top.Artist != streamedName+", "+got[1].Name {
		t.Fatalf("duet artists = %+v (%q)", got, top.Artist)
	}
}

// Legacy rows can credit two primary artists at the same position. Each top
// track artist's id, name and page flag still belong to the same artist, in
// one order (position, then id) that the display string follows too.
func TestReplayTopTrackArtistsStayPairedOnTiedPositions(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	viewer := redteamUser(t, ctx, pool)

	// Streamed only: no page. In the library too: a page.
	streamedName := "Tied Streamed " + uuid.NewString()[:8]
	duet := tidalPlay(t, ctx, pool, lib, streamedName)
	var streamed uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT artist_id FROM track_artists WHERE track_id=$1 AND position=0`, duet).Scan(&streamed); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM artists WHERE id=$1`, streamed) })
	local := pageArtist(t, ctx, pool, "Tied Local")
	credit(t, ctx, pool, redteamTrack(t, ctx, pool, nil, nil), local)
	if _, err := pool.Exec(ctx, `INSERT INTO track_artists(track_id,artist_id,role,position) VALUES($1,$2,'primary',0)`, duet, local); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO play_history(user_id,track_id,played_at) VALUES($1,$2,NOW())`, viewer, duet); err != nil {
		t.Fatal(err)
	}

	data, err := lib.ReplayStats(ctx, library.ReplayStatsParams{ViewerID: viewer})
	if err != nil {
		t.Fatal(err)
	}
	if len(data.TopTracks) != 1 || data.TopTracks[0].ID != duet {
		t.Fatalf("top tracks = %+v", data.TopTracks)
	}
	top := data.TopTracks[0]
	want := []library.ReplayTrackArtist{
		{ID: streamed, Name: streamedName, HasPage: false},
		{ID: local, Name: artistName(t, ctx, pool, local), HasPage: true},
	}
	if bytes.Compare(local[:], streamed[:]) < 0 {
		want[0], want[1] = want[1], want[0]
	}
	if !reflect.DeepEqual(top.PrimaryArtists, want) {
		t.Fatalf("artists = %+v, want %+v", top.PrimaryArtists, want)
	}
	if top.Artist != want[0].Name+", "+want[1].Name {
		t.Fatalf("artist = %q, want the names in the same order as %+v", top.Artist, want)
	}
}

// An album page links its album artist only when that artist has a page.
func TestAlbumSaysWhetherItsArtistHasAPage(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	lib := library.NewStore(pool)
	viewer, other := redteamUser(t, ctx, pool), redteamUser(t, ctx, pool)
	album := func(artist *uuid.UUID, credits ...uuid.UUID) uuid.UUID {
		t.Helper()
		id := redteamAlbum(t, ctx, pool, "", nil)
		if _, err := pool.Exec(ctx, `UPDATE albums SET album_artist_id=$2 WHERE id=$1`, id, artist); err != nil {
			t.Fatal(err)
		}
		credit(t, ctx, pool, redteamTrack(t, ctx, pool, nil, &id), credits...)
		return id
	}

	band := pageArtist(t, ctx, pool, "Band")
	various := pageArtist(t, ctx, pool, "Various")
	streamed := pageArtist(t, ctx, pool, "Streamed")
	tidalPlay(t, ctx, pool, lib, artistName(t, ctx, pool, streamed))
	private := pageArtist(t, ctx, pool, "Private")
	credit(t, ctx, pool, redteamTrack(t, ctx, pool, &other, nil), private)
	someone := pageArtist(t, ctx, pool, "Someone")

	for _, tc := range []struct {
		name   string
		artist *uuid.UUID
		viewer uuid.UUID
		want   bool
	}{
		{"credited on its tracks", &band, viewer, true},
		{"credited on no track", &various, viewer, false},
		{"credited only on a TIDAL play", &streamed, viewer, false},
		{"credited only on another user's upload", &private, viewer, false},
		{"credited on the viewer's own upload", &private, other, true},
		{"no album artist", nil, viewer, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			credits := []uuid.UUID{someone}
			if tc.artist != nil && *tc.artist == band {
				credits = []uuid.UUID{band}
			}
			id := album(tc.artist, credits...)
			a, err := lib.GetAlbum(ctx, id, tc.viewer)
			if err != nil {
				t.Fatal(err)
			}
			if a.ArtistHasPage != tc.want {
				t.Fatalf("artist_has_page = %v, want %v", a.ArtistHasPage, tc.want)
			}
			if tc.artist != nil && hasPage(t, ctx, lib, *tc.artist, tc.viewer) != tc.want {
				t.Fatalf("the artist page disagrees with artist_has_page = %v", tc.want)
			}
		})
	}
}
