package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/activity"
	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/httpapi/middleware"
	"github.com/githubesson/lumen/internal/models"
)

func TestActivitySocketBroadcastsPersonalizedSnapshots(t *testing.T) {
	userID := uuid.New()
	sessions := &activitySocketSessions{
		cookieName: "test_session",
		user:       &models.User{ID: userID, Username: "listener"},
	}
	store := &activitySocketStore{rows: make(map[string]activity.Activity)}
	background, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := &Activity{
		Store:      store,
		Hub:        activity.NewHub(),
		Sessions:   sessions,
		Background: background,
	}
	handler := middleware.Authenticate(sessions)(
		middleware.RequireUser(http.HandlerFunc(h.Socket)),
	)
	server := httptest.NewServer(handler)
	defer server.Close()

	ctx, cancelDial := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelDial()
	deviceA := dialActivitySocket(t, ctx, server.URL, sessions.cookieName, "a")
	defer deviceA.CloseNow()
	deviceB := dialActivitySocket(t, ctx, server.URL, sessions.cookieName, "b")
	defer deviceB.CloseNow()

	if initial := readActivitySocketMessage(t, ctx, deviceA); initial.Activity != nil {
		t.Fatalf("device A initial activity = %+v, want nil", initial.Activity)
	}
	if initial := readActivitySocketMessage(t, ctx, deviceB); initial.Activity != nil {
		t.Fatalf("device B initial activity = %+v, want nil", initial.Activity)
	}

	if err := wsjson.Write(ctx, deviceA, playbackSocketClientMessage{
		Type:     "activity.update",
		Protocol: playbackSocketProtocolVersion,
		Revision: 1,
		Activity: &playbackActivityReq{
			DeviceID:    "a",
			DeviceName:  "Phone",
			TrackID:     "track-1",
			Title:       "First track",
			PositionSec: 12,
			IsPlaying:   true,
		},
	}); err != nil {
		t.Fatalf("write update: %v", err)
	}

	updated := readActivitySocketMessage(t, ctx, deviceB)
	if updated.Type != "activity.snapshot" || updated.Protocol != playbackSocketProtocolVersion {
		t.Fatalf("unexpected server envelope: %+v", updated)
	}
	if updated.Activity == nil || updated.Activity.DeviceID != "a" || updated.Activity.PositionSec != 12 {
		t.Fatalf("device B activity = %+v, want device A at 12s", updated.Activity)
	}

	if err := wsjson.Write(ctx, deviceA, playbackSocketClientMessage{
		Type:     "activity.clear",
		Protocol: playbackSocketProtocolVersion,
		Revision: 2,
		DeviceID: "a",
	}); err != nil {
		t.Fatalf("write clear: %v", err)
	}
	if cleared := readActivitySocketMessage(t, ctx, deviceB); cleared.Activity != nil {
		t.Fatalf("device B cleared activity = %+v, want nil", cleared.Activity)
	}
}

func dialActivitySocket(
	t *testing.T,
	ctx context.Context,
	serverURL string,
	cookieName string,
	deviceID string,
) *websocket.Conn {
	t.Helper()
	header := http.Header{}
	header.Set("Cookie", (&http.Cookie{Name: cookieName, Value: "valid"}).String())
	url := "ws" + strings.TrimPrefix(serverURL, "http") + "/?device_id=" + deviceID
	conn, response, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		if response != nil {
			t.Fatalf("dial device %s: %v (HTTP %s)", deviceID, err, response.Status)
		}
		t.Fatalf("dial device %s: %v", deviceID, err)
	}
	return conn
}

func readActivitySocketMessage(
	t *testing.T,
	ctx context.Context,
	conn *websocket.Conn,
) playbackSocketServerMessage {
	t.Helper()
	var msg playbackSocketServerMessage
	if err := wsjson.Read(ctx, conn, &msg); err != nil {
		t.Fatalf("read socket message: %v", err)
	}
	return msg
}

type activitySocketSessions struct {
	cookieName string
	user       *models.User
}

func (s *activitySocketSessions) CookieName() string { return s.cookieName }

func (s *activitySocketSessions) LookupUser(
	context.Context,
	string,
) (auth.SessionInfo, *models.User, error) {
	return auth.SessionInfo{UserID: s.user.ID, ExpiresAt: time.Now().Add(time.Hour)}, s.user, nil
}

func (s *activitySocketSessions) ClearCookie(http.ResponseWriter) {}

type activitySocketStore struct {
	mu   sync.Mutex
	rows map[string]activity.Activity
}

func (s *activitySocketStore) Upsert(
	_ context.Context,
	in activity.UpsertInput,
) (*activity.Activity, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row := activity.Activity{
		UserID:      in.UserID,
		DeviceID:    in.DeviceID,
		DeviceName:  in.DeviceName,
		TrackID:     in.TrackID,
		Title:       in.Title,
		Artist:      in.Artist,
		Album:       in.Album,
		AlbumID:     in.AlbumID,
		CoverURL:    in.CoverURL,
		DurationSec: in.DurationSec,
		PositionSec: in.PositionSec,
		IsPlaying:   in.IsPlaying,
		UpdatedAt:   time.Now(),
	}
	s.rows[activitySocketKey(in.UserID, in.DeviceID)] = row
	return &row, nil
}

func (s *activitySocketStore) Current(
	_ context.Context,
	userID uuid.UUID,
	excludeDeviceID string,
	maxAge time.Duration,
) (*activity.Activity, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := time.Now().Add(-maxAge)
	var latest *activity.Activity
	for _, row := range s.rows {
		if row.UserID != userID || row.DeviceID == excludeDeviceID || row.UpdatedAt.Before(cutoff) {
			continue
		}
		copy := row
		if latest == nil || copy.UpdatedAt.After(latest.UpdatedAt) {
			latest = &copy
		}
	}
	return latest, nil
}

func (s *activitySocketStore) Delete(
	_ context.Context,
	userID uuid.UUID,
	deviceID string,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.rows, activitySocketKey(userID, deviceID))
	return nil
}

func activitySocketKey(userID uuid.UUID, deviceID string) string {
	return userID.String() + ":" + deviceID
}
