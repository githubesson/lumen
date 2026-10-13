package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/httpapi"
	"github.com/githubesson/lumen/internal/invites"
	"github.com/githubesson/lumen/internal/playlists"
	"github.com/githubesson/lumen/internal/users"
)

// Registering creates the account and uses up its invite together, and the
// admin user endpoints answer 404 for an account that doesn't exist.
func TestAccountRegistrationAndAdminUserAPI(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	admin := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id, username, password_hash, role) VALUES($1, $2, 'test', 'admin')`,
		admin, "accounts-"+admin.String()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, admin) })
	member := redteamUser(t, ctx, pool)

	inv := invites.NewStore(pool)
	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	router := httpapi.NewRouter(httpapi.Deps{
		DB: pool, Users: users.NewStore(pool), Invites: inv, Sessions: sessions,
		Playlists: playlists.NewStore(pool), CoverSignKey: []byte("test-key"),
	})
	token, _, err := sessions.Create(ctx, admin, httptest.NewRequest(http.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	do := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "session", Value: token})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	uses := func(id uuid.UUID) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, `SELECT uses FROM invites WHERE id = $1`, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	newInvite := func() invites.Created {
		t.Helper()
		created, err := inv.Create(ctx, invites.CreateParams{CreatedBy: admin})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM invites WHERE id = $1`, created.Invite.ID) })
		return created
	}
	register := func(invite invites.Created, username string) *httptest.ResponseRecorder {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"token": invite.Token, "username": username, "password": "long enough"})
		return do(http.MethodPost, "/api/auth/register", string(body))
	}

	t.Run("register", func(t *testing.T) {
		username := "registered-" + uuid.NewString()
		t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM users WHERE username = $1`, username) })
		first := newInvite()
		rec := register(first, username)
		if rec.Code != http.StatusCreated {
			t.Fatalf("register: %d %s", rec.Code, rec.Body)
		}
		var got struct {
			ID       string `json:"id"`
			Username string `json:"username"`
			Role     string `json:"role"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		var inviteID uuid.UUID
		if err := pool.QueryRow(ctx, `SELECT invite_id FROM users WHERE id = $1 AND username = $2`, got.ID, username).Scan(&inviteID); err != nil {
			t.Fatalf("registered user %+v not stored: %v", got, err)
		}
		if got.Role != "user" || inviteID != first.Invite.ID || uses(first.Invite.ID) != 1 {
			t.Fatalf("user %+v with invite %s; invite used %d times", got, inviteID, uses(first.Invite.ID))
		}

		// A taken username rolls the invite back.
		second := newInvite()
		if rec := register(second, username); rec.Code != http.StatusConflict {
			t.Fatalf("taken username: %d %s", rec.Code, rec.Body)
		}
		if n := uses(second.Invite.ID); n != 0 {
			t.Fatalf("a failed registration used the invite %d times", n)
		}
		if rec := register(first, "other-"+uuid.NewString()); rec.Code != http.StatusBadRequest {
			t.Fatalf("used-up invite: %d %s", rec.Code, rec.Body)
		}
	})

	t.Run("disable and enable", func(t *testing.T) {
		disabled := func() bool {
			t.Helper()
			rec := do(http.MethodGet, "/api/admin/users", "")
			var list []struct {
				ID       string `json:"id"`
				Disabled bool   `json:"disabled"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
				t.Fatalf("list: %d %s", rec.Code, rec.Body)
			}
			for _, u := range list {
				if u.ID == member.String() {
					return u.Disabled
				}
			}
			t.Fatal("member missing from the user list")
			return false
		}
		if rec := do(http.MethodPost, "/api/admin/users/"+member.String()+"/disable", ""); rec.Code != http.StatusNoContent || !disabled() {
			t.Fatalf("disable: %d %s", rec.Code, rec.Body)
		}
		if rec := do(http.MethodPost, "/api/admin/users/"+member.String()+"/enable", ""); rec.Code != http.StatusNoContent || disabled() {
			t.Fatalf("enable: %d %s", rec.Code, rec.Body)
		}
		for _, action := range []string{"disable", "enable"} {
			if rec := do(http.MethodPost, "/api/admin/users/"+uuid.NewString()+"/"+action, ""); rec.Code != http.StatusNotFound {
				t.Errorf("%s an unknown user: %d %s", action, rec.Code, rec.Body)
			}
		}
	})
}
