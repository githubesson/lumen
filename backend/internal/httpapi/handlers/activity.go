package handlers

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/githubesson/lumen/internal/activity"
	"github.com/githubesson/lumen/internal/auth"
	"github.com/githubesson/lumen/internal/httpapi/middleware"
	"github.com/githubesson/lumen/internal/models"
)

const playbackActivityMaxAge = 60 * time.Second

const (
	playbackSocketProtocolVersion = 1
	playbackSocketPingInterval    = 25 * time.Second
	playbackSocketRefreshInterval = 30 * time.Second
	playbackSocketWriteTimeout    = 10 * time.Second
	playbackSocketReadLimit       = 64 << 10
)

type playbackActivityStore interface {
	Upsert(context.Context, activity.UpsertInput) (*activity.Activity, error)
	Current(context.Context, uuid.UUID, string, time.Duration) (*activity.Activity, error)
	Delete(context.Context, uuid.UUID, string) error
}

type playbackSessionStore interface {
	LookupUser(context.Context, string) (auth.SessionInfo, *models.User, error)
}

type Activity struct {
	Store      playbackActivityStore
	Hub        *activity.Hub
	Sessions   playbackSessionStore
	Background context.Context
}

type playbackActivityReq struct {
	DeviceID    string `json:"device_id"`
	DeviceName  string `json:"device_name"`
	TrackID     string `json:"track_id"`
	Title       string `json:"title"`
	Artist      string `json:"artist,omitempty"`
	Album       string `json:"album,omitempty"`
	AlbumID     string `json:"album_id,omitempty"`
	CoverURL    string `json:"cover_url,omitempty"`
	DurationSec int    `json:"duration_sec,omitempty"`
	PositionSec int    `json:"position_sec"`
	IsPlaying   bool   `json:"is_playing"`
}

type playbackActivityResp struct {
	DeviceID    string `json:"device_id"`
	DeviceName  string `json:"device_name"`
	TrackID     string `json:"track_id"`
	Title       string `json:"title"`
	Artist      string `json:"artist,omitempty"`
	Album       string `json:"album,omitempty"`
	AlbumID     string `json:"album_id,omitempty"`
	CoverURL    string `json:"cover_url,omitempty"`
	DurationSec int    `json:"duration_sec,omitempty"`
	PositionSec int    `json:"position_sec"`
	IsPlaying   bool   `json:"is_playing"`
	UpdatedAt   string `json:"updated_at"`
}

type currentPlaybackActivityResp struct {
	Activity *playbackActivityResp `json:"activity"`
}

type playbackSocketClientMessage struct {
	Type     string               `json:"type"`
	Protocol int                  `json:"protocol"`
	Revision uint64               `json:"revision"`
	DeviceID string               `json:"device_id,omitempty"`
	Activity *playbackActivityReq `json:"activity,omitempty"`
}

type playbackSocketServerMessage struct {
	Type     string                `json:"type"`
	Protocol int                   `json:"protocol"`
	Activity *playbackActivityResp `json:"activity"`
}

func (h *Activity) Upsert(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	var req playbackActivityReq
	if !decodeJSON(w, r, &req) {
		return
	}
	out, err := h.Store.Upsert(r.Context(), activity.UpsertInput{
		UserID:      u.ID,
		DeviceID:    req.DeviceID,
		DeviceName:  req.DeviceName,
		TrackID:     req.TrackID,
		Title:       req.Title,
		Artist:      req.Artist,
		Album:       req.Album,
		AlbumID:     req.AlbumID,
		CoverURL:    req.CoverURL,
		DurationSec: req.DurationSec,
		PositionSec: req.PositionSec,
		IsPlaying:   req.IsPlaying,
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	h.notify(u.ID)
	writeJSON(w, http.StatusOK, toPlaybackActivityResp(out))
}

func (h *Activity) Current(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	out, err := h.Store.Current(
		r.Context(),
		u.ID,
		r.URL.Query().Get("exclude_device_id"),
		playbackActivityMaxAge,
	)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, currentPlaybackActivityResp{
		Activity: toPlaybackActivityResp(out),
	})
}

func (h *Activity) Delete(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	if err := h.Store.Delete(r.Context(), u.ID, chi.URLParam(r, "device_id")); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	h.notify(u.ID)
	w.WriteHeader(http.StatusNoContent)
}

// Socket upgrades an authenticated request into the live playback sync
// channel. PostgreSQL remains authoritative: socket notifications cause each
// connection to receive a fresh snapshot excluding its own device.
func (h *Activity) Socket(w http.ResponseWriter, r *http.Request) {
	u, ok := requireUser(w, r)
	if !ok {
		return
	}
	sessionToken, ok := middleware.SessionTokenFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	deviceID := strings.TrimSpace(r.URL.Query().Get("device_id"))
	if deviceID == "" || len(deviceID) > 200 {
		http.Error(w, "valid device_id required", http.StatusBadRequest)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(playbackSocketReadLimit)

	background := h.Background
	if background == nil {
		background = context.Background()
	}
	ctx, cancel := context.WithCancel(background)
	defer cancel()

	changes, unsubscribe := h.Hub.Subscribe(u.ID)
	defer unsubscribe()

	readDone := make(chan error, 1)
	writerDone := make(chan error, 1)
	go func() {
		readDone <- h.readPlaybackSocket(ctx, conn, u.ID, deviceID)
	}()
	go func() {
		writerDone <- h.writePlaybackSocket(ctx, conn, u.ID, deviceID, sessionToken, changes)
	}()

	var firstErr error
	select {
	case firstErr = <-readDone:
	case firstErr = <-writerDone:
	}
	cancel()
	if normalSocketClose(firstErr) {
		_ = conn.Close(websocket.StatusNormalClosure, "")
		return
	}
	_ = conn.Close(websocket.StatusInternalError, "playback sync disconnected")
}

func (h *Activity) readPlaybackSocket(
	ctx context.Context,
	conn *websocket.Conn,
	userID uuid.UUID,
	deviceID string,
) error {
	var lastRevision uint64
	for {
		var msg playbackSocketClientMessage
		if err := wsjson.Read(ctx, conn, &msg); err != nil {
			return err
		}
		if msg.Protocol != playbackSocketProtocolVersion {
			return errors.New("unsupported playback sync protocol")
		}
		if msg.Revision <= lastRevision {
			continue
		}

		switch msg.Type {
		case "activity.update":
			if msg.Activity == nil {
				return errors.New("activity payload required")
			}
			if strings.TrimSpace(msg.Activity.DeviceID) != deviceID {
				return errors.New("activity device_id does not match connection")
			}
			requestCtx, cancel := context.WithTimeout(ctx, playbackSocketWriteTimeout)
			_, err := h.Store.Upsert(requestCtx, activity.UpsertInput{
				UserID:      userID,
				DeviceID:    deviceID,
				DeviceName:  msg.Activity.DeviceName,
				TrackID:     msg.Activity.TrackID,
				Title:       msg.Activity.Title,
				Artist:      msg.Activity.Artist,
				Album:       msg.Activity.Album,
				AlbumID:     msg.Activity.AlbumID,
				CoverURL:    msg.Activity.CoverURL,
				DurationSec: msg.Activity.DurationSec,
				PositionSec: msg.Activity.PositionSec,
				IsPlaying:   msg.Activity.IsPlaying,
			})
			cancel()
			if err != nil {
				return err
			}
		case "activity.clear":
			if msg.DeviceID != "" && strings.TrimSpace(msg.DeviceID) != deviceID {
				return errors.New("clear device_id does not match connection")
			}
			requestCtx, cancel := context.WithTimeout(ctx, playbackSocketWriteTimeout)
			err := h.Store.Delete(requestCtx, userID, deviceID)
			cancel()
			if err != nil {
				return err
			}
		default:
			return errors.New("unsupported playback sync message")
		}

		lastRevision = msg.Revision
		h.notify(userID)
	}
}

func (h *Activity) writePlaybackSocket(
	ctx context.Context,
	conn *websocket.Conn,
	userID uuid.UUID,
	deviceID string,
	sessionToken string,
	changes <-chan struct{},
) error {
	if err := h.writePlaybackSnapshot(ctx, conn, userID, deviceID); err != nil {
		return err
	}

	pingTicker := time.NewTicker(playbackSocketPingInterval)
	defer pingTicker.Stop()
	refreshTicker := time.NewTicker(playbackSocketRefreshInterval)
	defer refreshTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-changes:
			if err := h.writePlaybackSnapshot(ctx, conn, userID, deviceID); err != nil {
				return err
			}
		case <-refreshTicker.C:
			authCtx, cancel := context.WithTimeout(ctx, playbackSocketWriteTimeout)
			_, currentUser, err := h.Sessions.LookupUser(authCtx, sessionToken)
			cancel()
			if err != nil || currentUser.Disabled || currentUser.MustResetPassword {
				return errors.New("playback sync session is no longer authorized")
			}
			// Refreshes let a stale activity disappear after its lease expires even
			// when the source device vanished without sending activity.clear.
			if err := h.writePlaybackSnapshot(ctx, conn, userID, deviceID); err != nil {
				return err
			}
		case <-pingTicker.C:
			pingCtx, cancel := context.WithTimeout(ctx, playbackSocketWriteTimeout)
			err := conn.Ping(pingCtx)
			cancel()
			if err != nil {
				return err
			}
		}
	}
}

func (h *Activity) writePlaybackSnapshot(
	ctx context.Context,
	conn *websocket.Conn,
	userID uuid.UUID,
	deviceID string,
) error {
	requestCtx, cancel := context.WithTimeout(ctx, playbackSocketWriteTimeout)
	current, err := h.Store.Current(requestCtx, userID, deviceID, playbackActivityMaxAge)
	cancel()
	if err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(ctx, playbackSocketWriteTimeout)
	defer cancel()
	return wsjson.Write(writeCtx, conn, playbackSocketServerMessage{
		Type:     "activity.snapshot",
		Protocol: playbackSocketProtocolVersion,
		Activity: toPlaybackActivityResp(current),
	})
}

func (h *Activity) notify(userID uuid.UUID) {
	if h.Hub != nil {
		h.Hub.Notify(userID)
	}
}

func normalSocketClose(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) {
		return true
	}
	status := websocket.CloseStatus(err)
	return status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway
}

func toPlaybackActivityResp(a *activity.Activity) *playbackActivityResp {
	if a == nil {
		return nil
	}
	return &playbackActivityResp{
		DeviceID:    a.DeviceID,
		DeviceName:  a.DeviceName,
		TrackID:     a.TrackID,
		Title:       a.Title,
		Artist:      a.Artist,
		Album:       a.Album,
		AlbumID:     a.AlbumID,
		CoverURL:    a.CoverURL,
		DurationSec: a.DurationSec,
		PositionSec: a.PositionSec,
		IsPlaying:   a.IsPlaying,
		UpdatedAt:   a.UpdatedAt.Format(time.RFC3339Nano),
	}
}
