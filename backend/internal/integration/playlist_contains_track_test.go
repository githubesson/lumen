package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/httpapi"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/playlists"
	"github.com/githubesson/lumen/internal/users"
)

// The add-to-playlist picker asks the list which playlists already hold a
// track. The answer covers exactly the playlists the list shows, resolves the
// id the way AddTracks does, and leaves the plain list unchanged.
func TestPlaylistListContainsTrack(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	viewer := redteamUser(t, ctx, pool)
	friend := redteamUser(t, ctx, pool)

	lib := library.NewStore(pool)
	pls := playlists.NewStore(pool)
	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	router := httpapi.NewRouter(httpapi.Deps{
		DB: pool, Users: users.NewStore(pool), Sessions: sessions, Library: lib, Playlists: pls,
		CoverSignKey: []byte("test-key"),
	})

	track := redteamTrack(t, ctx, pool, nil, nil)
	other := redteamTrack(t, ctx, pool, nil, nil)
	friendsUpload := redteamTrack(t, ctx, pool, &friend, nil)
	tidalID := "c" + uuid.NewString()[:8]
	remote, err := lib.UpsertRemoteTrack(ctx, library.RemoteTrackInput{
		Source: "tidal", ExternalID: tidalID, Title: tidalID, ArtistNames: []string{"Artist"}, DurationMS: 1000,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM tracks WHERE id = $1`, remote) })

	playlist := func(owner uuid.UUID, visibility playlists.Visibility, tracks ...uuid.UUID) uuid.UUID {
		t.Helper()
		p, err := pls.Create(ctx, owner, "contains", "", visibility)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM playlists WHERE id = $1`, p.ID) })
		if err := pls.AddTracks(ctx, p.ID, tracks, owner); err != nil {
			t.Fatal(err)
		}
		return p.ID
	}
	collaborate := func(playlistID uuid.UUID, status string) {
		t.Helper()
		if _, err := pool.Exec(ctx, `INSERT INTO playlist_collaborators(playlist_id, user_id, role, status) VALUES($1, $2, 'editor', $3)`,
			playlistID, viewer, status); err != nil {
			t.Fatal(err)
		}
	}
	holds := playlist(viewer, playlists.VisibilityPrivate, other, track)
	lacks := playlist(viewer, playlists.VisibilityPrivate, other)
	holdsRemote := playlist(viewer, playlists.VisibilityPrivate, remote)
	holdsUpload := playlist(viewer, playlists.VisibilityPrivate, friendsUpload)
	shared := playlist(friend, playlists.VisibilityCollaborative, track)
	collaborate(shared, "accepted")
	// Neither is on the viewer's list, so neither may answer for the track.
	pending := playlist(friend, playlists.VisibilityCollaborative, track)
	collaborate(pending, "pending")
	hidden := playlist(friend, playlists.VisibilityPrivate, track)
	collaborate(hidden, "accepted")

	token, _, err := sessions.Create(ctx, viewer, httptest.NewRequest(http.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	list := func(trackID string) (int, map[uuid.UUID]map[string]any) {
		t.Helper()
		path := "/api/playlists"
		if trackID != "" {
			path += "?track_id=" + url.QueryEscape(trackID)
		}
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.AddCookie(&http.Cookie{Name: "session", Value: token})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			return rec.Code, nil
		}
		var rows []map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &rows); err != nil {
			t.Fatalf("decode %s: %v", rec.Body, err)
		}
		out := map[uuid.UUID]map[string]any{}
		for _, row := range rows {
			out[uuid.MustParse(row["id"].(string))] = row
		}
		return rec.Code, out
	}
	expect := func(trackID string, want map[uuid.UUID]bool) {
		t.Helper()
		code, rows := list(trackID)
		if code != http.StatusOK {
			t.Fatalf("track_id=%q: status %d", trackID, code)
		}
		if len(rows) != len(want) {
			t.Fatalf("track_id=%q: listed %d playlists, want %d", trackID, len(rows), len(want))
		}
		for id, contains := range want {
			row, ok := rows[id]
			if !ok {
				t.Fatalf("track_id=%q: playlist %s missing", trackID, id)
			}
			if got, ok := row["contains_track"].(bool); !ok || got != contains {
				t.Fatalf("track_id=%q: playlist %s contains_track = %v, want %v", trackID, id, row["contains_track"], contains)
			}
		}
	}

	// Without the parameter the response doesn't carry the field at all.
	code, plain := list("")
	if code != http.StatusOK || len(plain) != 5 {
		t.Fatalf("plain list: status %d, %d playlists", code, len(plain))
	}
	for id, row := range plain {
		if _, ok := row["contains_track"]; ok {
			t.Fatalf("plain list: playlist %s has contains_track", id)
		}
	}

	expect(track.String(), map[uuid.UUID]bool{holds: true, lacks: false, holdsRemote: false, holdsUpload: false, shared: true})
	expect("local:"+track.String(), map[uuid.UUID]bool{holds: true, lacks: false, holdsRemote: false, holdsUpload: false, shared: true})
	expect("tidal:"+tidalID, map[uuid.UUID]bool{holds: false, lacks: false, holdsRemote: true, holdsUpload: false, shared: false})
	expect(remote.String(), map[uuid.UUID]bool{holds: false, lacks: false, holdsRemote: true, holdsUpload: false, shared: false})
	// Tracks nobody could have added are in no playlist, rather than an
	// error: a TIDAL track the library hasn't seen, a missing id, and
	// another user's upload, which must look the same as a missing one.
	none := map[uuid.UUID]bool{holds: false, lacks: false, holdsRemote: false, holdsUpload: false, shared: false}
	expect("tidal:"+uuid.NewString()[:8], none)
	expect(uuid.NewString(), none)
	expect(friendsUpload.String(), none)

	if code, _ := list("not-a-track"); code != http.StatusBadRequest {
		t.Fatalf("malformed track_id: status %d, want 400", code)
	}
}
