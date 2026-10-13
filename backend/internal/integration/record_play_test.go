package integration

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/httpapi"
	"github.com/githubesson/lumen/internal/library"
	"github.com/githubesson/lumen/internal/users"
)

// A play's optional body is read however it is sent: a chunked one, with
// no Content-Length, used to be ignored.
func TestRecordPlayReadsAChunkedBody(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	viewer := redteamUser(t, ctx, pool)
	track := redteamTrack(t, ctx, pool, nil, nil)
	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	router := httpapi.NewRouter(httpapi.Deps{
		DB: pool, Users: users.NewStore(pool), Sessions: sessions,
		Library: library.NewStore(pool), CoverSignKey: []byte("test-key"),
	})
	token, _, err := sessions.Create(ctx, viewer, httptest.NewRequest(http.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	play := func(body string) int {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/tracks/"+track.String()+"/play", strings.NewReader(body))
		req.ContentLength = -1
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "session", Value: token})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec.Code
	}
	if code := play(`{"completion":0.5}`); code != http.StatusNoContent {
		t.Fatalf("play: %d", code)
	}
	if code := play(""); code != http.StatusNoContent {
		t.Fatalf("play without a body: %d", code)
	}
	if code := play("{"); code != http.StatusBadRequest {
		t.Fatalf("play with a malformed body: %d", code)
	}
	rows, err := pool.Query(ctx, `SELECT completion FROM play_history WHERE user_id = $1 ORDER BY played_at, completion DESC`, viewer)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []float32
	for rows.Next() {
		var c float32
		if err := rows.Scan(&c); err != nil {
			t.Fatal(err)
		}
		got = append(got, c)
	}
	if len(got) != 2 || got[0] != 0.5 || got[1] != 0 {
		t.Fatalf("recorded completions %v, want [0.5 0]", got)
	}
}
