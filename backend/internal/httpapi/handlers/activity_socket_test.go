package handlers

import (
	"context"
	"encoding/json"
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

	volume := 0.42
	muted := true
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
			Volume:      &volume,
			Muted:       &muted,
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
	if updated.Activity.Volume != volume || !updated.Activity.Muted {
		t.Fatalf("device B volume = %v muted = %v, want %v/true", updated.Activity.Volume, updated.Activity.Muted, volume)
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

func TestActivitySocketRoutesRemoteControlCommands(t *testing.T) {
	userID := uuid.New()
	sessions := &activitySocketSessions{
		cookieName: "test_session",
		user:       &models.User{ID: userID, Username: "controller"},
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
	controller := dialActivitySocket(t, ctx, server.URL, sessions.cookieName, "phone")
	defer controller.CloseNow()
	target := dialActivitySocket(t, ctx, server.URL, sessions.cookieName, "desktop")
	defer target.CloseNow()
	readActivitySocketMessage(t, ctx, controller)
	readActivitySocketMessage(t, ctx, target)

	writeSocketMessage(t, ctx, controller, playbackSocketClientMessage{
		Type:           "device.hello",
		Protocol:       playbackSocketProtocolVersion,
		Revision:       1,
		DeviceName:     "iPhone",
		Capabilities:   []string{"playback", "seek", "volume", "queue"},
		ControlEnabled: true,
	})
	writeSocketMessage(t, ctx, target, playbackSocketClientMessage{
		Type:           "device.hello",
		Protocol:       playbackSocketProtocolVersion,
		Revision:       1,
		DeviceName:     "Desktop",
		Capabilities:   []string{"playback", "seek", "volume", "queue"},
		ControlEnabled: true,
	})

	controllerDevices := readDeviceSnapshotContaining(t, ctx, controller, "desktop")
	if len(controllerDevices.Devices) != 2 {
		t.Fatalf("controller devices = %+v, want two", controllerDevices.Devices)
	}
	readDeviceSnapshotContaining(t, ctx, target, "phone")

	queue := json.RawMessage(`{"revision":"queue-1","tracks":[{"id":"t70","title":"Song","duration_ms":1000},{"id":"t71","title":"Next","duration_ms":1000}],"index":0,"offset":70,"total":120,"shuffle":true,"repeat":"all"}`)
	writeSocketMessage(t, ctx, target, playbackSocketClientMessage{
		Type: "activity.update", Protocol: playbackSocketProtocolVersion, Revision: 2,
		Activity: &playbackActivityReq{DeviceID: "desktop", DeviceName: "Desktop", TrackID: "t70", Title: "Song", IsPlaying: true},
		Queue:    queue,
	})
	for {
		snapshot := readDeviceSnapshotContaining(t, ctx, controller, "desktop")
		found := false
		for _, device := range snapshot.Devices {
			if device.DeviceID == "desktop" && len(device.Queue) > 0 {
				var got map[string]any
				if err := json.Unmarshal(device.Queue, &got); err != nil {
					t.Fatal(err)
				}
				if got["revision"] != "queue-1" || got["offset"] != float64(70) || got["shuffle"] != true {
					t.Fatalf("unexpected queue: %s", device.Queue)
				}
				found = true
			}
		}
		if found {
			break
		}
	}
	// A controller connecting after playback began receives the existing queue.
	late := dialActivitySocket(t, ctx, server.URL, sessions.cookieName, "late-phone")
	defer late.CloseNow()
	writeSocketMessage(t, ctx, late, playbackSocketClientMessage{
		Type: "device.hello", Protocol: playbackSocketProtocolVersion, Revision: 1,
		DeviceName: "Late phone", Capabilities: []string{"queue"}, ControlEnabled: true,
	})
	snapshot := readDeviceSnapshotContaining(t, ctx, late, "desktop")
	for _, device := range snapshot.Devices {
		if device.DeviceID == "desktop" && len(device.Queue) == 0 {
			t.Fatal("late controller missed queue")
		}
	}

	commandID := uuid.NewString()
	writeSocketMessage(t, ctx, controller, playbackSocketClientMessage{
		Type:           "playback.command",
		Protocol:       playbackSocketProtocolVersion,
		Revision:       2,
		CommandID:      commandID,
		TargetDeviceID: "desktop",
		Action:         "set_playing",
		Args:           json.RawMessage(`{"playing":false}`),
	})
	routed := readSocketMessageType(t, ctx, target, "playback.command")
	if routed.CommandID != commandID || routed.SourceDeviceID != "phone" ||
		routed.TargetDeviceID != "desktop" || routed.Action != "set_playing" {
		t.Fatalf("routed command = %+v", routed)
	}
	if string(routed.Args) != `{"playing":false}` {
		t.Fatalf("routed args = %s", routed.Args)
	}

	writeSocketMessage(t, ctx, target, playbackSocketClientMessage{
		Type:      "playback.command_result",
		Protocol:  playbackSocketProtocolVersion,
		Revision:  3,
		CommandID: commandID,
		Status:    "applied",
	})
	result := readSocketMessageType(t, ctx, controller, "playback.command_result")
	if result.CommandID != commandID || result.Status != "applied" ||
		result.TargetDeviceID != "desktop" {
		t.Fatalf("command result = %+v", result)
	}

	writeSocketMessage(t, ctx, controller, playbackSocketClientMessage{
		Type:           "playback.command",
		Protocol:       playbackSocketProtocolVersion,
		Revision:       3,
		CommandID:      uuid.NewString(),
		TargetDeviceID: "offline-device",
		Action:         "next",
		Args:           json.RawMessage(`{}`),
	})
	offline := readSocketMessageType(t, ctx, controller, "playback.command_result")
	if offline.Status != "offline" || offline.TargetDeviceID != "offline-device" {
		t.Fatalf("offline result = %+v", offline)
	}
	writeSocketMessage(t, ctx, target, playbackSocketClientMessage{
		Type: "activity.clear", Protocol: playbackSocketProtocolVersion, Revision: 4, DeviceID: "desktop",
	})
	for {
		snapshot := readDeviceSnapshotContaining(t, ctx, controller, "desktop")
		cleared := false
		for _, device := range snapshot.Devices {
			if device.DeviceID == "desktop" && device.Activity == nil && len(device.Queue) == 0 {
				cleared = true
			}
		}
		if cleared {
			break
		}
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

func writeSocketMessage(
	t *testing.T,
	ctx context.Context,
	conn *websocket.Conn,
	msg playbackSocketClientMessage,
) {
	t.Helper()
	if err := wsjson.Write(ctx, conn, msg); err != nil {
		t.Fatalf("write socket message %s: %v", msg.Type, err)
	}
}

func readSocketMessageType(
	t *testing.T,
	ctx context.Context,
	conn *websocket.Conn,
	wantType string,
) playbackSocketServerMessage {
	t.Helper()
	for {
		msg := readActivitySocketMessage(t, ctx, conn)
		if msg.Type == wantType {
			return msg
		}
	}
}

func readDeviceSnapshotContaining(
	t *testing.T,
	ctx context.Context,
	conn *websocket.Conn,
	deviceID string,
) playbackSocketServerMessage {
	t.Helper()
	for {
		msg := readSocketMessageType(t, ctx, conn, "devices.snapshot")
		for _, device := range msg.Devices {
			if device.DeviceID == deviceID {
				return msg
			}
		}
	}
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
	key := activitySocketKey(in.UserID, in.DeviceID)
	volume := 1.0
	muted := false
	if previous, ok := s.rows[key]; ok {
		volume = previous.Volume
		muted = previous.Muted
	}
	if in.Volume != nil {
		volume = *in.Volume
	}
	if in.Muted != nil {
		muted = *in.Muted
	}
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
		Volume:      volume,
		Muted:       muted,
		UpdatedAt:   time.Now(),
	}
	s.rows[key] = row
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

func (s *activitySocketStore) ListRecent(
	_ context.Context,
	userID uuid.UUID,
	maxAge time.Duration,
) ([]activity.Activity, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := time.Now().Add(-maxAge)
	out := make([]activity.Activity, 0)
	for _, row := range s.rows {
		if row.UserID == userID && !row.UpdatedAt.Before(cutoff) {
			out = append(out, row)
		}
	}
	return out, nil
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
