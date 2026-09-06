package activity

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestHubScopesAndCoalescesActivityNotifications(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	userA := uuid.New()
	userB := uuid.New()
	a1, cancelA1 := hub.Register(userA, "a1")
	defer cancelA1()
	a2, cancelA2 := hub.Register(userA, "a2")
	defer cancelA2()
	b, cancelB := hub.Register(userB, "b")
	defer cancelB()

	hub.NotifyActivity(userA)
	hub.NotifyActivity(userA)

	assertSignaled(t, a1.ActivityChanges)
	assertSignaled(t, a2.ActivityChanges)
	assertNotSignaled(t, b.ActivityChanges)
	assertNotSignaled(t, a1.ActivityChanges)
}

func TestHubCancelIsIdempotent(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	userID := uuid.New()
	sub, cancel := hub.Register(userID, "phone")
	cancel()
	cancel()
	hub.NotifyActivity(userID)
	assertNotSignaled(t, sub.ActivityChanges)
	assertClosed(t, sub.Done)
}

func TestHubListsOnlyAnnouncedDevices(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	userID := uuid.New()
	legacy, cancelLegacy := hub.Register(userID, "legacy")
	defer cancelLegacy()
	phone, cancelPhone := hub.Register(userID, "phone")
	defer cancelPhone()

	if !hub.Announce(phone, "iPhone", []string{"volume", "playback"}, true) {
		t.Fatal("announce phone failed")
	}
	if hub.IsAnnounced(legacy) {
		t.Fatal("legacy connection unexpectedly announced")
	}
	devices := hub.Devices(userID)
	if len(devices) != 1 {
		t.Fatalf("devices = %+v, want one announced device", devices)
	}
	if devices[0].DeviceID != "phone" || devices[0].DeviceName != "iPhone" ||
		!devices[0].ControlEnabled {
		t.Fatalf("unexpected device: %+v", devices[0])
	}
	if got := devices[0].Capabilities; len(got) != 2 || got[0] != "playback" || got[1] != "volume" {
		t.Fatalf("capabilities = %v", got)
	}
}

func TestHubRoutesAndResolvesCommand(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	userID := uuid.New()
	controller, cancelController := hub.Register(userID, "controller")
	defer cancelController()
	target, cancelTarget := hub.Register(userID, "desktop")
	defer cancelTarget()
	hub.Announce(controller, "Phone", []string{"playback"}, true)
	hub.Announce(target, "Desktop", []string{"playback"}, true)

	command := Command{
		CommandID:          uuid.NewString(),
		TargetDeviceID:     "desktop",
		Action:             "set_playing",
		RequiredCapability: "playback",
		Args:               json.RawMessage(`{"playing":false}`),
	}
	if immediate := hub.RouteCommand(controller, command); immediate != nil {
		t.Fatalf("route returned immediate result: %+v", immediate)
	}
	routed := receiveCommand(t, target.Commands)
	if routed.SourceDeviceID != "controller" || routed.TargetDeviceID != "desktop" ||
		routed.CommandID != command.CommandID {
		t.Fatalf("unexpected routed command: %+v", routed)
	}
	if !hub.ResolveCommand(target, "applied", command.CommandID, "") {
		t.Fatal("resolve command failed")
	}
	result := receiveResult(t, controller.Results)
	if result.Status != "applied" || result.TargetDeviceID != "desktop" {
		t.Fatalf("unexpected result: %+v", result)
	}

	// Retrying a completed command is idempotent and returns the cached result
	// without delivering the command to the target twice.
	cached := hub.RouteCommand(controller, command)
	if cached == nil || cached.Status != "applied" {
		t.Fatalf("cached result = %+v", cached)
	}
	assertNoCommand(t, target.Commands)
}

func TestHubRejectsOfflineUnsupportedAndCrossUserTargets(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	userA := uuid.New()
	userB := uuid.New()
	controller, cancelController := hub.Register(userA, "controller")
	defer cancelController()
	target, cancelTarget := hub.Register(userA, "desktop")
	defer cancelTarget()
	otherUserTarget, cancelOther := hub.Register(userB, "other")
	defer cancelOther()
	hub.Announce(controller, "Phone", []string{"playback"}, true)
	hub.Announce(target, "Desktop", []string{"playback"}, true)
	hub.Announce(otherUserTarget, "Other", []string{"volume"}, true)

	offline := hub.RouteCommand(controller, Command{
		CommandID:      uuid.NewString(),
		TargetDeviceID: "missing",
		Action:         "next",
	})
	if offline == nil || offline.Status != "offline" {
		t.Fatalf("offline result = %+v", offline)
	}

	unsupported := hub.RouteCommand(controller, Command{
		CommandID:          uuid.NewString(),
		TargetDeviceID:     "desktop",
		Action:             "set_volume",
		RequiredCapability: "volume",
	})
	if unsupported == nil || unsupported.Status != "unsupported" {
		t.Fatalf("unsupported result = %+v", unsupported)
	}

	crossUser := hub.RouteCommand(controller, Command{
		CommandID:      uuid.NewString(),
		TargetDeviceID: "other",
		Action:         "next",
	})
	if crossUser == nil || crossUser.Status != "offline" {
		t.Fatalf("cross-user result = %+v", crossUser)
	}
}

func TestHubTimesOutUnacknowledgedCommand(t *testing.T) {
	t.Parallel()

	hub := NewHubWithCommandTimeout(20 * time.Millisecond)
	userID := uuid.New()
	controller, cancelController := hub.Register(userID, "controller")
	defer cancelController()
	target, cancelTarget := hub.Register(userID, "desktop")
	defer cancelTarget()
	hub.Announce(controller, "Phone", []string{"playback"}, true)
	hub.Announce(target, "Desktop", []string{"playback"}, true)

	commandID := uuid.NewString()
	if immediate := hub.RouteCommand(controller, Command{
		CommandID:          commandID,
		TargetDeviceID:     "desktop",
		Action:             "next",
		RequiredCapability: "playback",
	}); immediate != nil {
		t.Fatalf("route returned immediate result: %+v", immediate)
	}
	receiveCommand(t, target.Commands)
	result := receiveResult(t, controller.Results)
	if result.CommandID != commandID || result.Status != "timeout" {
		t.Fatalf("timeout result = %+v", result)
	}
}

func assertSignaled(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	default:
		t.Fatal("expected notification")
	}
}

func assertNotSignaled(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
		t.Fatal("unexpected notification")
	default:
	}
}

func assertClosed(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	default:
		t.Fatal("expected closed channel")
	}
}

func receiveCommand(t *testing.T, ch <-chan Command) Command {
	t.Helper()
	select {
	case command := <-ch:
		return command
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for command")
		return Command{}
	}
}

func assertNoCommand(t *testing.T, ch <-chan Command) {
	t.Helper()
	select {
	case command := <-ch:
		t.Fatalf("unexpected command: %+v", command)
	case <-time.After(20 * time.Millisecond):
	}
}

func receiveResult(t *testing.T, ch <-chan CommandResult) CommandResult {
	t.Helper()
	select {
	case result := <-ch:
		return result
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for result")
		return CommandResult{}
	}
}

func TestQueueSnapshotsBelongToUserAndConnection(t *testing.T) {
	h := NewHub()
	user := uuid.New()
	old, cancelOld := h.Register(user, "desktop")
	defer cancelOld()
	h.Announce(old, "Desktop", []string{"queue"}, true)
	queue := json.RawMessage(`{"revision":"v1"}`)
	if !h.UpdateQueue(old, queue) {
		t.Fatal("queue update failed")
	}
	queue[0] = 'x'
	devices := h.Devices(user)
	if string(devices[0].Queue) != `{"revision":"v1"}` {
		t.Fatal("queue was not copied")
	}
	devices[0].Queue[0] = 'x'
	if string(h.Devices(user)[0].Queue) != `{"revision":"v1"}` {
		t.Fatal("snapshot mutated hub queue")
	}
	if len(h.Devices(uuid.New())) != 0 {
		t.Fatal("queue leaked to another user")
	}
	replacement, cancelReplacement := h.Register(user, "desktop")
	defer cancelReplacement()
	h.Announce(replacement, "Desktop", []string{"queue"}, true)
	if h.UpdateQueue(old, json.RawMessage(`{}`)) {
		t.Fatal("stale connection updated queue")
	}
	if len(h.Devices(user)[0].Queue) != 0 {
		t.Fatal("reconnect retained stale queue")
	}
	cancelReplacement()
	if len(h.Devices(user)) != 0 {
		t.Fatal("disconnected device retained")
	}
}
