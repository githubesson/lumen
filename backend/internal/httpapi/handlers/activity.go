package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
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
	playbackDeviceNameMaxLength   = 100
	playbackCommandErrorMaxLength = 500
	playbackCommandMaxPerSecond   = 30
)

const (
	playbackCapabilityPlayback = "playback"
	playbackCapabilitySeek     = "seek"
	playbackCapabilityVolume   = "volume"
	playbackCapabilityQueue    = "queue"
)

var playbackCapabilities = map[string]struct{}{
	playbackCapabilityPlayback: {},
	playbackCapabilitySeek:     {},
	playbackCapabilityVolume:   {},
	playbackCapabilityQueue:    {},
}

type playbackActivityStore interface {
	Upsert(context.Context, activity.UpsertInput) (*activity.Activity, error)
	Current(context.Context, uuid.UUID, string, time.Duration) (*activity.Activity, error)
	ListRecent(context.Context, uuid.UUID, time.Duration) ([]activity.Activity, error)
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
	DeviceID    string   `json:"device_id"`
	DeviceName  string   `json:"device_name"`
	TrackID     string   `json:"track_id"`
	Title       string   `json:"title"`
	Artist      string   `json:"artist,omitempty"`
	Album       string   `json:"album,omitempty"`
	AlbumID     string   `json:"album_id,omitempty"`
	CoverURL    string   `json:"cover_url,omitempty"`
	DurationSec int      `json:"duration_sec,omitempty"`
	PositionSec int      `json:"position_sec"`
	IsPlaying   bool     `json:"is_playing"`
	Volume      *float64 `json:"volume,omitempty"`
	Muted       *bool    `json:"muted,omitempty"`
}

type playbackActivityResp struct {
	DeviceID    string  `json:"device_id"`
	DeviceName  string  `json:"device_name"`
	TrackID     string  `json:"track_id"`
	Title       string  `json:"title"`
	Artist      string  `json:"artist,omitempty"`
	Album       string  `json:"album,omitempty"`
	AlbumID     string  `json:"album_id,omitempty"`
	CoverURL    string  `json:"cover_url,omitempty"`
	DurationSec int     `json:"duration_sec,omitempty"`
	PositionSec int     `json:"position_sec"`
	IsPlaying   bool    `json:"is_playing"`
	Volume      float64 `json:"volume"`
	Muted       bool    `json:"muted"`
	UpdatedAt   string  `json:"updated_at"`
}

type currentPlaybackActivityResp struct {
	Activity *playbackActivityResp `json:"activity"`
}

type playbackSocketClientMessage struct {
	Type           string               `json:"type"`
	Protocol       int                  `json:"protocol"`
	Revision       uint64               `json:"revision"`
	DeviceID       string               `json:"device_id,omitempty"`
	DeviceName     string               `json:"device_name,omitempty"`
	Capabilities   []string             `json:"capabilities,omitempty"`
	ControlEnabled bool                 `json:"control_enabled,omitempty"`
	Activity       *playbackActivityReq `json:"activity,omitempty"`
	CommandID      string               `json:"command_id,omitempty"`
	TargetDeviceID string               `json:"target_device_id,omitempty"`
	Action         string               `json:"action,omitempty"`
	Args           json.RawMessage      `json:"args,omitempty"`
	Status         string               `json:"status,omitempty"`
	Error          string               `json:"error,omitempty"`
}

type playbackSocketServerMessage struct {
	Type           string                `json:"type"`
	Protocol       int                   `json:"protocol"`
	Activity       *playbackActivityResp `json:"activity"`
	Devices        []playbackDeviceResp  `json:"devices,omitempty"`
	CommandID      string                `json:"command_id,omitempty"`
	SourceDeviceID string                `json:"source_device_id,omitempty"`
	TargetDeviceID string                `json:"target_device_id,omitempty"`
	Action         string                `json:"action,omitempty"`
	Args           json.RawMessage       `json:"args,omitempty"`
	Status         string                `json:"status,omitempty"`
	Error          string                `json:"error,omitempty"`
}

type playbackDeviceResp struct {
	DeviceID       string                `json:"device_id"`
	DeviceName     string                `json:"device_name"`
	Online         bool                  `json:"online"`
	ControlEnabled bool                  `json:"control_enabled"`
	Capabilities   []string              `json:"capabilities"`
	ConnectedAt    string                `json:"connected_at"`
	Activity       *playbackActivityResp `json:"activity"`
}

type playbackCommandTrack struct {
	ID            string `json:"id"`
	DBTrackID     string `json:"db_track_id,omitempty"`
	Source        string `json:"source,omitempty"`
	SourceID      string `json:"source_id,omitempty"`
	SourceAlbumID string `json:"source_album_id,omitempty"`
	Title         string `json:"title"`
	AlbumID       string `json:"album_id,omitempty"`
	AlbumTitle    string `json:"album_title,omitempty"`
	TrackNo       int    `json:"track_no,omitempty"`
	DurationMS    int    `json:"duration_ms"`
	Artist        string `json:"artist,omitempty"`
	AKA           string `json:"aka,omitempty"`
	Favorited     bool   `json:"favorited,omitempty"`
	HasCover      bool   `json:"has_cover,omitempty"`
	CoverURL      string `json:"cover_url,omitempty"`
	Owned         bool   `json:"owned,omitempty"`
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
		Volume:      req.Volume,
		Muted:       req.Muted,
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
	subscription, unsubscribe := h.Hub.Register(u.ID, deviceID)
	defer unsubscribe()

	background := h.Background
	if background == nil {
		background = context.Background()
	}
	ctx, cancel := context.WithCancel(background)
	defer cancel()

	readDone := make(chan error, 1)
	writerDone := make(chan error, 1)
	// Both pumps are outside chi's Recoverer. A panic must still deliver on the
	// channel below, or the handler would block forever holding the connection.
	go func() {
		defer func() {
			if p := recover(); p != nil {
				slog.Error("activity socket read pump panicked", "panic", p)
				readDone <- errors.New("read pump panicked")
			}
		}()
		readDone <- h.readPlaybackSocket(ctx, conn, subscription)
	}()
	go func() {
		defer func() {
			if p := recover(); p != nil {
				slog.Error("activity socket write pump panicked", "panic", p)
				writerDone <- errors.New("write pump panicked")
			}
		}()
		writerDone <- h.writePlaybackSocket(ctx, conn, subscription, sessionToken)
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
	subscription *activity.Subscription,
) error {
	var lastRevision uint64
	commandWindowStarted := time.Now()
	commandCount := 0
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
		case "device.hello":
			deviceName, capabilities, err := validateDeviceHello(
				msg.DeviceName,
				msg.Capabilities,
			)
			if err != nil {
				return err
			}
			if !h.Hub.Announce(
				subscription,
				deviceName,
				capabilities,
				msg.ControlEnabled,
			) {
				return errors.New("device connection is no longer current")
			}
		case "activity.update":
			if msg.Activity == nil {
				return errors.New("activity payload required")
			}
			if strings.TrimSpace(msg.Activity.DeviceID) != subscription.DeviceID {
				return errors.New("activity device_id does not match connection")
			}
			requestCtx, cancel := context.WithTimeout(ctx, playbackSocketWriteTimeout)
			_, err := h.Store.Upsert(requestCtx, activity.UpsertInput{
				UserID:      subscription.UserID,
				DeviceID:    subscription.DeviceID,
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
				Volume:      msg.Activity.Volume,
				Muted:       msg.Activity.Muted,
			})
			cancel()
			if err != nil {
				return err
			}
		case "activity.clear":
			if msg.DeviceID != "" && strings.TrimSpace(msg.DeviceID) != subscription.DeviceID {
				return errors.New("clear device_id does not match connection")
			}
			requestCtx, cancel := context.WithTimeout(ctx, playbackSocketWriteTimeout)
			err := h.Store.Delete(requestCtx, subscription.UserID, subscription.DeviceID)
			cancel()
			if err != nil {
				return err
			}
		case "playback.command":
			now := time.Now()
			if now.Sub(commandWindowStarted) >= time.Second {
				commandWindowStarted = now
				commandCount = 0
			}
			commandCount++
			if commandCount > playbackCommandMaxPerSecond {
				return errors.New("playback command rate exceeded")
			}
			command, err := validatePlaybackCommand(msg)
			if err != nil {
				return err
			}
			if result := h.Hub.RouteCommand(subscription, command); result != nil {
				h.Hub.SendResult(subscription, *result)
			}
		case "playback.command_result":
			commandID, status, message, err := validatePlaybackCommandResult(msg)
			if err != nil {
				return err
			}
			if !h.Hub.ResolveCommand(subscription, status, commandID, message) {
				return errors.New("unknown or unauthorized command result")
			}
		default:
			return errors.New("unsupported playback sync message")
		}

		lastRevision = msg.Revision
		if msg.Type == "activity.update" || msg.Type == "activity.clear" {
			h.notify(subscription.UserID)
		}
	}
}

func (h *Activity) writePlaybackSocket(
	ctx context.Context,
	conn *websocket.Conn,
	subscription *activity.Subscription,
	sessionToken string,
) error {
	if err := h.writePlaybackSnapshot(
		ctx,
		conn,
		subscription.UserID,
		subscription.DeviceID,
	); err != nil {
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
		case <-subscription.Done:
			return context.Canceled
		case <-subscription.ActivityChanges:
			if err := h.writePlaybackSnapshot(
				ctx,
				conn,
				subscription.UserID,
				subscription.DeviceID,
			); err != nil {
				return err
			}
		case <-subscription.DeviceChanges:
			if h.Hub.IsAnnounced(subscription) {
				if err := h.writeDeviceSnapshot(ctx, conn, subscription.UserID); err != nil {
					return err
				}
			}
		case command := <-subscription.Commands:
			if err := writePlaybackCommand(ctx, conn, command); err != nil {
				return err
			}
		case result := <-subscription.Results:
			if err := writePlaybackCommandResult(ctx, conn, result); err != nil {
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
			if err := h.writePlaybackSnapshot(
				ctx,
				conn,
				subscription.UserID,
				subscription.DeviceID,
			); err != nil {
				return err
			}
			if h.Hub.IsAnnounced(subscription) {
				if err := h.writeDeviceSnapshot(ctx, conn, subscription.UserID); err != nil {
					return err
				}
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

func (h *Activity) writeDeviceSnapshot(
	ctx context.Context,
	conn *websocket.Conn,
	userID uuid.UUID,
) error {
	requestCtx, cancel := context.WithTimeout(ctx, playbackSocketWriteTimeout)
	recent, err := h.Store.ListRecent(requestCtx, userID, playbackActivityMaxAge)
	cancel()
	if err != nil {
		return err
	}
	activityByDevice := make(map[string]*playbackActivityResp, len(recent))
	for i := range recent {
		activityByDevice[recent[i].DeviceID] = toPlaybackActivityResp(&recent[i])
	}

	devices := h.Hub.Devices(userID)
	response := make([]playbackDeviceResp, 0, len(devices))
	for _, device := range devices {
		response = append(response, playbackDeviceResp{
			DeviceID:       device.DeviceID,
			DeviceName:     device.DeviceName,
			Online:         true,
			ControlEnabled: device.ControlEnabled,
			Capabilities:   device.Capabilities,
			ConnectedAt:    device.ConnectedAt.Format(time.RFC3339Nano),
			Activity:       activityByDevice[device.DeviceID],
		})
	}

	writeCtx, cancel := context.WithTimeout(ctx, playbackSocketWriteTimeout)
	defer cancel()
	return wsjson.Write(writeCtx, conn, playbackSocketServerMessage{
		Type:     "devices.snapshot",
		Protocol: playbackSocketProtocolVersion,
		Devices:  response,
	})
}

func writePlaybackCommand(
	ctx context.Context,
	conn *websocket.Conn,
	command activity.Command,
) error {
	writeCtx, cancel := context.WithTimeout(ctx, playbackSocketWriteTimeout)
	defer cancel()
	return wsjson.Write(writeCtx, conn, playbackSocketServerMessage{
		Type:           "playback.command",
		Protocol:       playbackSocketProtocolVersion,
		CommandID:      command.CommandID,
		SourceDeviceID: command.SourceDeviceID,
		TargetDeviceID: command.TargetDeviceID,
		Action:         command.Action,
		Args:           command.Args,
	})
}

func writePlaybackCommandResult(
	ctx context.Context,
	conn *websocket.Conn,
	result activity.CommandResult,
) error {
	writeCtx, cancel := context.WithTimeout(ctx, playbackSocketWriteTimeout)
	defer cancel()
	return wsjson.Write(writeCtx, conn, playbackSocketServerMessage{
		Type:           "playback.command_result",
		Protocol:       playbackSocketProtocolVersion,
		CommandID:      result.CommandID,
		SourceDeviceID: result.SourceDeviceID,
		TargetDeviceID: result.TargetDeviceID,
		Status:         result.Status,
		Error:          result.Error,
	})
}

func validateDeviceHello(deviceName string, capabilities []string) (string, []string, error) {
	deviceName = strings.TrimSpace(deviceName)
	if deviceName == "" {
		return "", nil, errors.New("device_name required")
	}
	if len(deviceName) > playbackDeviceNameMaxLength {
		return "", nil, errors.New("device_name too long")
	}
	seen := make(map[string]struct{}, len(capabilities))
	out := make([]string, 0, len(capabilities))
	for _, capability := range capabilities {
		capability = strings.TrimSpace(capability)
		if _, ok := playbackCapabilities[capability]; !ok {
			return "", nil, fmt.Errorf("unsupported capability %q", capability)
		}
		if _, ok := seen[capability]; ok {
			continue
		}
		seen[capability] = struct{}{}
		out = append(out, capability)
	}
	sort.Strings(out)
	return deviceName, out, nil
}

func validatePlaybackCommand(msg playbackSocketClientMessage) (activity.Command, error) {
	commandID := strings.TrimSpace(msg.CommandID)
	parsedCommandID, err := uuid.Parse(commandID)
	if err != nil {
		return activity.Command{}, errors.New("valid command_id required")
	}
	targetDeviceID := strings.TrimSpace(msg.TargetDeviceID)
	if targetDeviceID == "" || len(targetDeviceID) > 200 {
		return activity.Command{}, errors.New("valid target_device_id required")
	}
	action := strings.TrimSpace(msg.Action)
	args, capability, err := validatePlaybackCommandArgs(action, msg.Args)
	if err != nil {
		return activity.Command{}, err
	}
	return activity.Command{
		CommandID:          parsedCommandID.String(),
		TargetDeviceID:     targetDeviceID,
		Action:             action,
		RequiredCapability: capability,
		Args:               args,
	}, nil
}

func validatePlaybackCommandArgs(
	action string,
	raw json.RawMessage,
) (json.RawMessage, string, error) {
	switch action {
	case "play_track":
		var args struct {
			Track playbackCommandTrack   `json:"track"`
			Queue []playbackCommandTrack `json:"queue"`
		}
		if err := decodeStrictArgs(raw, &args); err != nil ||
			!validPlaybackCommandTrack(args.Track) || len(args.Queue) == 0 || len(args.Queue) > 50 {
			return nil, "", errors.New("play_track requires a valid track and queue of 1 to 50 tracks")
		}
		for _, track := range args.Queue {
			if !validPlaybackCommandTrack(track) {
				return nil, "", errors.New("play_track queue contains an invalid track")
			}
		}
		return marshalCommandArgs(args), playbackCapabilityPlayback, nil
	case "set_playing":
		var args struct {
			Playing *bool `json:"playing"`
		}
		if err := decodeStrictArgs(raw, &args); err != nil || args.Playing == nil {
			return nil, "", errors.New("set_playing requires boolean playing")
		}
		return marshalCommandArgs(struct {
			Playing bool `json:"playing"`
		}{Playing: *args.Playing}), playbackCapabilityPlayback, nil
	case "next", "previous":
		var args struct{}
		if err := decodeStrictArgs(raw, &args); err != nil {
			return nil, "", fmt.Errorf("%s does not accept arguments", action)
		}
		return json.RawMessage(`{}`), playbackCapabilityPlayback, nil
	case "seek":
		var args struct {
			PositionSec *float64 `json:"position_sec"`
		}
		if err := decodeStrictArgs(raw, &args); err != nil || args.PositionSec == nil ||
			*args.PositionSec < 0 || *args.PositionSec > 24*60*60 {
			return nil, "", errors.New("seek requires position_sec between 0 and 86400")
		}
		return marshalCommandArgs(struct {
			PositionSec float64 `json:"position_sec"`
		}{PositionSec: *args.PositionSec}), playbackCapabilitySeek, nil
	case "set_volume":
		var args struct {
			Volume *float64 `json:"volume"`
		}
		if err := decodeStrictArgs(raw, &args); err != nil || args.Volume == nil ||
			*args.Volume < 0 || *args.Volume > 1 {
			return nil, "", errors.New("set_volume requires volume between 0 and 1")
		}
		return marshalCommandArgs(struct {
			Volume float64 `json:"volume"`
		}{Volume: *args.Volume}), playbackCapabilityVolume, nil
	case "set_muted":
		var args struct {
			Muted *bool `json:"muted"`
		}
		if err := decodeStrictArgs(raw, &args); err != nil || args.Muted == nil {
			return nil, "", errors.New("set_muted requires boolean muted")
		}
		return marshalCommandArgs(struct {
			Muted bool `json:"muted"`
		}{Muted: *args.Muted}), playbackCapabilityVolume, nil
	case "set_shuffle":
		var args struct {
			Shuffle *bool `json:"shuffle"`
		}
		if err := decodeStrictArgs(raw, &args); err != nil || args.Shuffle == nil {
			return nil, "", errors.New("set_shuffle requires boolean shuffle")
		}
		return marshalCommandArgs(struct {
			Shuffle bool `json:"shuffle"`
		}{Shuffle: *args.Shuffle}), playbackCapabilityQueue, nil
	case "set_repeat":
		var args struct {
			Repeat *string `json:"repeat"`
		}
		if err := decodeStrictArgs(raw, &args); err != nil || args.Repeat == nil ||
			(*args.Repeat != "off" && *args.Repeat != "all" && *args.Repeat != "one") {
			return nil, "", errors.New("set_repeat requires repeat off, all, or one")
		}
		return marshalCommandArgs(struct {
			Repeat string `json:"repeat"`
		}{Repeat: *args.Repeat}), playbackCapabilityQueue, nil
	default:
		return nil, "", errors.New("unsupported playback command action")
	}
}

func validPlaybackCommandTrack(track playbackCommandTrack) bool {
	return strings.TrimSpace(track.ID) != "" && len(track.ID) <= 500 &&
		strings.TrimSpace(track.Title) != "" && len(track.Title) <= 1000 &&
		track.DurationMS >= 0 && track.DurationMS <= 24*60*60*1000
}

func validatePlaybackCommandResult(
	msg playbackSocketClientMessage,
) (commandID, status, message string, err error) {
	parsedCommandID, err := uuid.Parse(strings.TrimSpace(msg.CommandID))
	if err != nil {
		return "", "", "", errors.New("valid command_id required")
	}
	status = strings.TrimSpace(msg.Status)
	if status != "applied" && status != "rejected" && status != "unsupported" {
		return "", "", "", errors.New("invalid playback command result status")
	}
	message = strings.TrimSpace(msg.Error)
	if len(message) > playbackCommandErrorMaxLength {
		return "", "", "", errors.New("playback command result error too long")
	}
	return parsedCommandID.String(), status, message, nil
}

func decodeStrictArgs(raw json.RawMessage, dst any) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = json.RawMessage(`{}`)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("multiple JSON values in command arguments")
	}
	return nil
}

func marshalCommandArgs(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return encoded
}

func (h *Activity) notify(userID uuid.UUID) {
	if h.Hub != nil {
		h.Hub.NotifyActivity(userID)
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
		Volume:      a.Volume,
		Muted:       a.Muted,
		UpdatedAt:   a.UpdatedAt.Format(time.RFC3339Nano),
	}
}
