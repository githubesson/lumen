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
	"github.com/jackc/pgx/v5"

	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/dbutil"
	"github.com/githubesson/lumen/internal/httpapi"
	"github.com/githubesson/lumen/internal/invites"
	"github.com/githubesson/lumen/internal/playlists"
	"github.com/githubesson/lumen/internal/users"
)

// An API key calls the API as the user who made it, admin routes included
// for an admin, but can't manage keys, change the password or sign out. A
// revoked, expired or unknown key is refused outright.
func TestAPIKeys(t *testing.T) {
	ctx, pool := openRedteamDB(t)
	admin := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id, username, password_hash, role) VALUES($1, $2, 'test', 'admin')`,
		admin, "apikeys-"+admin.String()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, admin) })
	member := redteamUser(t, ctx, pool)

	sessions := auth.NewSessionStore(pool, "session", false, time.Hour)
	keys := auth.NewAPIKeyStore(pool)
	usersStore := users.NewStore(pool)
	router := httpapi.NewRouter(httpapi.Deps{
		DB: pool, Users: usersStore, Invites: invites.NewStore(pool), Sessions: sessions, APIKeys: keys,
		Playlists: playlists.NewStore(pool), CoverSignKey: []byte("test-key"),
	})
	memberSession, _, err := sessions.Create(ctx, member, httptest.NewRequest(http.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	type creds struct{ cookie, bearer string }
	do := func(c creds, method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if c.cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: c.cookie})
		}
		if c.bearer != "" {
			req.Header.Set("Authorization", "Bearer "+c.bearer)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	me := func(c creds) (int, string) {
		t.Helper()
		rec := do(c, http.MethodGet, "/api/auth/me", "")
		var got struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &got)
		return rec.Code, got.ID
	}
	type keyJSON struct {
		ID         string     `json:"id"`
		Name       string     `json:"name"`
		Prefix     string     `json:"prefix"`
		Key        string     `json:"key"`
		LastUsedAt *time.Time `json:"last_used_at"`
		ExpiresAt  *time.Time `json:"expires_at"`
	}
	session := creds{cookie: memberSession}
	create := func(body string) keyJSON {
		t.Helper()
		rec := do(session, http.MethodPost, "/api/auth/api-keys", body)
		if rec.Code != http.StatusCreated {
			t.Fatalf("create %s: %d %s", body, rec.Code, rec.Body)
		}
		var k keyJSON
		if err := json.Unmarshal(rec.Body.Bytes(), &k); err != nil {
			t.Fatal(err)
		}
		return k
	}
	list := func() []keyJSON {
		t.Helper()
		rec := do(session, http.MethodGet, "/api/auth/api-keys", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("list: %d %s", rec.Code, rec.Body)
		}
		var ks []keyJSON
		if err := json.Unmarshal(rec.Body.Bytes(), &ks); err != nil {
			t.Fatal(err)
		}
		return ks
	}

	if ks := list(); len(ks) != 0 {
		t.Fatalf("new user has keys: %+v", ks)
	}
	made := create(`{"name":"  stats script  "}`)
	if !strings.HasPrefix(made.Key, auth.APIKeyPrefix) || made.Prefix != made.Key[:len(made.Prefix)] ||
		len(made.Prefix) <= len(auth.APIKeyPrefix) || made.Name != "stats script" || made.ExpiresAt != nil {
		t.Fatalf("created key %+v", made)
	}
	key := creds{bearer: made.Key}

	t.Run("acts as its user", func(t *testing.T) {
		if code, id := me(key); code != http.StatusOK || id != member.String() {
			t.Fatalf("me with key: %d %s", code, id)
		}
		// The key wins over another user's cookie.
		adminSession, _, err := sessions.Create(ctx, admin, httptest.NewRequest(http.MethodGet, "/", nil))
		if err != nil {
			t.Fatal(err)
		}
		if code, id := me(creds{cookie: adminSession, bearer: made.Key}); code != http.StatusOK || id != member.String() {
			t.Fatalf("me with key and admin cookie: %d %s", code, id)
		}
		if rec := do(key, http.MethodGet, "/api/playlists", ""); rec.Code != http.StatusOK {
			t.Fatalf("playlists with key: %d %s", rec.Code, rec.Body)
		}
		if rec := do(key, http.MethodGet, "/api/admin/users", ""); rec.Code != http.StatusForbidden {
			t.Fatalf("member key on admin route: %d", rec.Code)
		}
		ks := list()
		if len(ks) != 1 || ks[0].ID != made.ID || ks[0].LastUsedAt == nil || ks[0].Key != "" {
			t.Fatalf("listed keys after use: %+v", ks)
		}
	})

	t.Run("admin key reaches admin routes", func(t *testing.T) {
		plain, _, err := keys.Create(ctx, admin, "admin script", nil)
		if err != nil {
			t.Fatal(err)
		}
		if rec := do(creds{bearer: plain}, http.MethodGet, "/api/admin/users", ""); rec.Code != http.StatusOK {
			t.Fatalf("admin key on admin route: %d %s", rec.Code, rec.Body)
		}
	})

	t.Run("session-only routes refuse keys", func(t *testing.T) {
		for _, route := range []struct{ method, path, body string }{
			{http.MethodGet, "/api/auth/api-keys", ""},
			{http.MethodPost, "/api/auth/api-keys", `{"name":"minted"}`},
			{http.MethodDelete, "/api/auth/api-keys/" + made.ID, ""},
			{http.MethodPost, "/api/auth/reset-password", `{"current_password":"x","new_password":"long enough"}`},
			{http.MethodPost, "/api/auth/logout", ""},
			{http.MethodGet, "/api/activity/ws?device_id=d", ""},
		} {
			if rec := do(key, route.method, route.path, route.body); rec.Code != http.StatusForbidden {
				t.Errorf("%s %s with key: %d %s", route.method, route.path, rec.Code, rec.Body)
			}
		}
		if ks := list(); len(ks) != 1 {
			t.Fatalf("a refused route changed the keys: %+v", ks)
		}
	})

	t.Run("bad keys are refused", func(t *testing.T) {
		rec := do(creds{cookie: memberSession, bearer: auth.APIKeyPrefix + "nope"}, http.MethodGet, "/api/auth/me", "")
		if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Header().Get("WWW-Authenticate"), "invalid_token") {
			t.Fatalf("unknown key beside a good cookie: %d %q", rec.Code, rec.Header().Get("WWW-Authenticate"))
		}
		// Another program's bearer token isn't ours: the cookie still counts.
		if code, id := me(creds{cookie: memberSession, bearer: "eyJhbGciOi.proxy.token"}); code != http.StatusOK || id != member.String() {
			t.Fatalf("foreign bearer token with cookie: %d %s", code, id)
		}
		past := time.Now().Add(-time.Minute)
		expired, _, err := keys.Create(ctx, member, "expired", &past)
		if err != nil {
			t.Fatal(err)
		}
		if code, _ := me(creds{bearer: expired}); code != http.StatusUnauthorized {
			t.Fatalf("expired key: %d", code)
		}
	})

	t.Run("validation", func(t *testing.T) {
		for _, body := range []string{
			`{"name":""}`,
			`{"name":"   "}`,
			`{"name":"` + strings.Repeat("x", 101) + `"}`,
			`{"name":"tab\tname"}`,
			`{"name":"ok","expires_in_days":-1}`,
			`{"name":"ok","expires_in_days":3651}`,
		} {
			if rec := do(session, http.MethodPost, "/api/auth/api-keys", body); rec.Code != http.StatusBadRequest {
				t.Errorf("create %s: %d", body, rec.Code)
			}
		}
		k := create(`{"name":"monthly","expires_in_days":30}`)
		if k.ExpiresAt == nil || k.ExpiresAt.Sub(time.Now().AddDate(0, 0, 30)).Abs() > time.Minute {
			t.Fatalf("30-day key expires %v", k.ExpiresAt)
		}
	})

	t.Run("delete", func(t *testing.T) {
		other, otherKey, err := keys.Create(ctx, admin, "not yours", nil)
		if err != nil {
			t.Fatal(err)
		}
		if rec := do(session, http.MethodDelete, "/api/auth/api-keys/"+otherKey.ID.String(), ""); rec.Code != http.StatusNotFound {
			t.Fatalf("deleting another user's key: %d", rec.Code)
		}
		if code, _ := me(creds{bearer: other}); code != http.StatusOK {
			t.Fatalf("another user's key after a refused delete: %d", code)
		}
		if rec := do(session, http.MethodDelete, "/api/auth/api-keys/"+made.ID, ""); rec.Code != http.StatusNoContent {
			t.Fatalf("delete: %d %s", rec.Code, rec.Body)
		}
		if code, _ := me(key); code != http.StatusUnauthorized {
			t.Fatalf("deleted key: %d", code)
		}
	})

	t.Run("cap", func(t *testing.T) {
		user := redteamUser(t, ctx, pool)
		for i := 0; i < auth.MaxAPIKeysPerUser; i++ {
			if _, _, err := keys.Create(ctx, user, "k", nil); err != nil {
				t.Fatalf("key %d: %v", i, err)
			}
		}
		if _, _, err := keys.Create(ctx, user, "one too many", nil); err != auth.ErrTooManyAPIKeys {
			t.Fatalf("key past the cap: %v", err)
		}
	})

	t.Run("password change and disable revoke keys", func(t *testing.T) {
		changer := redteamUser(t, ctx, pool)
		plain, _, err := keys.Create(ctx, changer, "k", nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := usersStore.ChangePassword(ctx, changer, "test", "new-hash"); err != nil {
			t.Fatal(err)
		}
		if code, _ := me(creds{bearer: plain}); code != http.StatusUnauthorized {
			t.Fatalf("key after a password change: %d", code)
		}

		disabled := redteamUser(t, ctx, pool)
		plain, _, err = keys.Create(ctx, disabled, "k", nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := dbutil.WithTx(ctx, pool, func(tx pgx.Tx) error { return usersStore.DisableTx(ctx, tx, disabled) }); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE users SET disabled = FALSE WHERE id = $1`, disabled); err != nil {
			t.Fatal(err)
		}
		if code, _ := me(creds{bearer: plain}); code != http.StatusUnauthorized {
			t.Fatalf("key after disable and re-enable: %d", code)
		}
	})
}
