package handlers

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func TestValidatePlaybackCommand(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		action     string
		args       string
		capability string
		wantError  bool
	}{
		{name: "queue jump", action: "jump_to", args: `{"index":70,"track_id":"t70","queue_revision":"v1"}`, capability: "queue"},
		{name: "queue jump missing revision", action: "jump_to", args: `{"index":0,"track_id":"t70"}`, wantError: true},
		{name: "queue jump negative", action: "jump_to", args: `{"index":-1,"track_id":"t70","queue_revision":"v1"}`, wantError: true},
		{name: "queue jump fractional", action: "jump_to", args: `{"index":0.5,"track_id":"t70","queue_revision":"v1"}`, wantError: true},
		{name: "play track", action: "play_track", args: `{"track":{"id":"track-1","title":"Song","duration_ms":180000},"queue":[{"id":"track-1","title":"Song","duration_ms":180000}]}`, capability: "playback"},
		{name: "play", action: "set_playing", args: `{"playing":true}`, capability: "playback"},
		{name: "next", action: "next", args: `{}`, capability: "playback"},
		{name: "previous omitted args", action: "previous", capability: "playback"},
		{name: "seek", action: "seek", args: `{"position_sec":12.5}`, capability: "seek"},
		{name: "volume", action: "set_volume", args: `{"volume":0.75}`, capability: "volume"},
		{name: "mute", action: "set_muted", args: `{"muted":false}`, capability: "volume"},
		{name: "shuffle", action: "set_shuffle", args: `{"shuffle":true}`, capability: "queue"},
		{name: "repeat", action: "set_repeat", args: `{"repeat":"one"}`, capability: "queue"},
		{name: "unknown action", action: "toggle", args: `{}`, wantError: true},
		{name: "missing boolean", action: "set_playing", args: `{}`, wantError: true},
		{name: "unknown field", action: "next", args: `{"extra":true}`, wantError: true},
		{name: "negative seek", action: "seek", args: `{"position_sec":-1}`, wantError: true},
		{name: "volume above one", action: "set_volume", args: `{"volume":1.1}`, wantError: true},
		{name: "bad repeat", action: "set_repeat", args: `{"repeat":"track"}`, wantError: true},
		{name: "play track missing queue", action: "play_track", args: `{"track":{"id":"track-1","title":"Song","duration_ms":180000}}`, wantError: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			command, err := validatePlaybackCommand(playbackSocketClientMessage{
				CommandID:      uuid.NewString(),
				TargetDeviceID: "desktop",
				Action:         test.action,
				Args:           json.RawMessage(test.args),
			})
			if test.wantError {
				if err == nil {
					t.Fatalf("validate command unexpectedly succeeded: %+v", command)
				}
				return
			}
			if err != nil {
				t.Fatalf("validate command: %v", err)
			}
			if command.RequiredCapability != test.capability {
				t.Fatalf("capability = %q, want %q", command.RequiredCapability, test.capability)
			}
		})
	}
}

func TestValidateDeviceHello(t *testing.T) {
	t.Parallel()

	name, capabilities, err := validateDeviceHello(
		"  Desktop  ",
		[]string{"volume", "playback", "volume"},
	)
	if err != nil {
		t.Fatalf("validate hello: %v", err)
	}
	if name != "Desktop" {
		t.Fatalf("name = %q", name)
	}
	if len(capabilities) != 2 || capabilities[0] != "playback" || capabilities[1] != "volume" {
		t.Fatalf("capabilities = %v", capabilities)
	}
	if _, _, err := validateDeviceHello("Desktop", []string{"filesystem"}); err == nil {
		t.Fatal("unsupported capability accepted")
	}
}

func TestValidatePlaybackQueue(t *testing.T) {
	base := map[string]any{
		"revision": "v1", "tracks": []playbackCommandTrack{{ID: "t1", Title: "Song", DurationMS: 1000}},
		"index": 0, "offset": 70, "total": 120, "shuffle": true, "repeat": "all",
	}
	for _, test := range []struct {
		name  string
		key   string
		value any
	}{
		{"missing revision", "revision", ""},
		{"invalid index", "index", 1},
		{"negative offset", "offset", -1},
		{"inconsistent total", "total", 70},
		{"missing tracks", "tracks", nil},
		{"invalid track", "tracks", []playbackCommandTrack{{ID: "t1"}}},
		{"too many tracks", "tracks", make([]playbackCommandTrack, 51)},
		{"invalid repeat", "repeat", "invalid"},
	} {
		t.Run(test.name, func(t *testing.T) {
			copy := make(map[string]any)
			for key, value := range base {
				copy[key] = value
			}
			copy[test.key] = test.value
			if _, err := validatePlaybackQueue(marshalCommandArgs(copy)); err == nil {
				t.Fatal("invalid queue accepted")
			}
		})
	}
	if _, err := validatePlaybackQueue(marshalCommandArgs(base)); err != nil {
		t.Fatal(err)
	}
	base["tracks"] = []playbackCommandTrack{}
	base["index"], base["offset"], base["total"] = 0, 0, 0
	if _, err := validatePlaybackQueue(marshalCommandArgs(base)); err != nil {
		t.Fatalf("empty queue: %v", err)
	}
}
