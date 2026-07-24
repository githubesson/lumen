package activity

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	defaultCommandTimeout = 10 * time.Second
	completedCommandTTL   = 2 * time.Minute
	eventBufferSize       = 32
)

var (
	ErrSourceNotRegistered = errors.New("source device is not registered")
	ErrTargetOffline       = errors.New("target device is offline")
	ErrTargetBusy          = errors.New("target device is busy")
	ErrTargetUnsupported   = errors.New("target does not support this command")
	ErrDuplicateCommand    = errors.New("command is already pending")
)

type Device struct {
	DeviceID       string
	DeviceName     string
	Capabilities   []string
	ControlEnabled bool
	ConnectedAt    time.Time
}

type Command struct {
	CommandID          string
	SourceDeviceID     string
	TargetDeviceID     string
	Action             string
	RequiredCapability string
	Args               json.RawMessage
}

type CommandResult struct {
	CommandID      string
	SourceDeviceID string
	TargetDeviceID string
	Status         string
	Error          string
}

type Subscription struct {
	UserID     uuid.UUID
	DeviceID   string
	Connection uint64

	ActivityChanges chan struct{}
	DeviceChanges   chan struct{}
	Commands        chan Command
	Results         chan CommandResult
	Done            chan struct{}

	once sync.Once
}

type pendingCommand struct {
	command Command
	timer   *time.Timer
}

type completedCommand struct {
	result    CommandResult
	expiresAt time.Time
}

type deviceConnection struct {
	subscription *Subscription
	announced    bool
	deviceName   string
	capabilities map[string]struct{}
	control      bool
	connectedAt  time.Time
}

// Hub owns online device presence and routes ephemeral playback commands.
// Playback state remains authoritative in PostgreSQL; commands are deliberately
// not queued for offline devices because replaying stale transport controls is
// more surprising than returning an immediate offline result.
type Hub struct {
	mu             sync.Mutex
	nextConnection uint64
	connections    map[uuid.UUID]map[string]*deviceConnection
	pending        map[string]*pendingCommand
	completed      map[string]completedCommand
	commandTimeout time.Duration
}

func NewHub() *Hub {
	return NewHubWithCommandTimeout(defaultCommandTimeout)
}

func NewHubWithCommandTimeout(timeout time.Duration) *Hub {
	if timeout <= 0 {
		timeout = defaultCommandTimeout
	}
	return &Hub{
		connections:    make(map[uuid.UUID]map[string]*deviceConnection),
		pending:        make(map[string]*pendingCommand),
		completed:      make(map[string]completedCommand),
		commandTimeout: timeout,
	}
}

func (h *Hub) Register(userID uuid.UUID, deviceID string) (*Subscription, func()) {
	h.mu.Lock()
	defer h.mu.Unlock()

	deviceID = strings.TrimSpace(deviceID)
	h.nextConnection++
	sub := &Subscription{
		UserID:          userID,
		DeviceID:        deviceID,
		Connection:      h.nextConnection,
		ActivityChanges: make(chan struct{}, 1),
		DeviceChanges:   make(chan struct{}, 1),
		Commands:        make(chan Command, eventBufferSize),
		Results:         make(chan CommandResult, eventBufferSize),
		Done:            make(chan struct{}),
	}

	if h.connections[userID] == nil {
		h.connections[userID] = make(map[string]*deviceConnection)
	}
	if previous := h.connections[userID][deviceID]; previous != nil {
		previous.subscription.once.Do(func() { close(previous.subscription.Done) })
		h.failPendingForTargetLocked(userID, deviceID, "offline", "target connection replaced")
	}
	h.connections[userID][deviceID] = &deviceConnection{
		subscription: sub,
		capabilities: make(map[string]struct{}),
		connectedAt:  time.Now(),
	}
	h.signalDevicesLocked(userID)

	var once sync.Once
	cancel := func() {
		once.Do(func() { h.unregister(sub) })
	}
	return sub, cancel
}

func (h *Hub) unregister(sub *Subscription) {
	h.mu.Lock()
	defer h.mu.Unlock()

	devices := h.connections[sub.UserID]
	current := devices[sub.DeviceID]
	if current == nil || current.subscription.Connection != sub.Connection {
		sub.once.Do(func() { close(sub.Done) })
		return
	}
	delete(devices, sub.DeviceID)
	if len(devices) == 0 {
		delete(h.connections, sub.UserID)
	}
	sub.once.Do(func() { close(sub.Done) })
	h.failPendingForTargetLocked(sub.UserID, sub.DeviceID, "offline", "target device disconnected")
	h.signalDevicesLocked(sub.UserID)
}

func (h *Hub) Announce(
	sub *Subscription,
	deviceName string,
	capabilities []string,
	controlEnabled bool,
) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	connection := h.currentConnectionLocked(sub)
	if connection == nil {
		return false
	}
	connection.announced = true
	connection.deviceName = strings.TrimSpace(deviceName)
	connection.capabilities = make(map[string]struct{}, len(capabilities))
	for _, capability := range capabilities {
		capability = strings.TrimSpace(capability)
		if capability != "" {
			connection.capabilities[capability] = struct{}{}
		}
	}
	connection.control = controlEnabled
	h.signalDevicesLocked(sub.UserID)
	return true
}

func (h *Hub) IsAnnounced(sub *Subscription) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	connection := h.currentConnectionLocked(sub)
	return connection != nil && connection.announced
}

func (h *Hub) Devices(userID uuid.UUID) []Device {
	h.mu.Lock()
	defer h.mu.Unlock()

	connections := h.connections[userID]
	out := make([]Device, 0, len(connections))
	for deviceID, connection := range connections {
		if !connection.announced {
			continue
		}
		capabilities := make([]string, 0, len(connection.capabilities))
		for capability := range connection.capabilities {
			capabilities = append(capabilities, capability)
		}
		sort.Strings(capabilities)
		out = append(out, Device{
			DeviceID:       deviceID,
			DeviceName:     connection.deviceName,
			Capabilities:   capabilities,
			ControlEnabled: connection.control,
			ConnectedAt:    connection.connectedAt,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].DeviceName == out[j].DeviceName {
			return out[i].DeviceID < out[j].DeviceID
		}
		return out[i].DeviceName < out[j].DeviceName
	})
	return out
}

func (h *Hub) NotifyActivity(userID uuid.UUID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, connection := range h.connections[userID] {
		signal(connection.subscription.ActivityChanges)
		if connection.announced {
			signal(connection.subscription.DeviceChanges)
		}
	}
}

// RouteCommand either queues a command for its online target or returns an
// immediate result that the caller should send back to the source device.
// A nil result means the command is pending target acknowledgement.
func (h *Hub) RouteCommand(sub *Subscription, command Command) *CommandResult {
	h.mu.Lock()
	defer h.mu.Unlock()

	now := time.Now()
	h.pruneCompletedLocked(now)
	command.SourceDeviceID = sub.DeviceID
	key := commandKey(sub.UserID, command.CommandID)

	if completed, ok := h.completed[key]; ok {
		if completed.result.SourceDeviceID != sub.DeviceID ||
			completed.result.TargetDeviceID != command.TargetDeviceID {
			return immediateResult(command, "rejected", "command_id already used")
		}
		result := completed.result
		return &result
	}
	if pending, ok := h.pending[key]; ok {
		if pending.command.SourceDeviceID != sub.DeviceID ||
			pending.command.TargetDeviceID != command.TargetDeviceID ||
			pending.command.Action != command.Action {
			return immediateResult(command, "rejected", "command_id already used")
		}
		return immediateResult(command, "pending", ErrDuplicateCommand.Error())
	}
	source := h.currentConnectionLocked(sub)
	if source == nil || !source.announced {
		return immediateResult(command, "rejected", ErrSourceNotRegistered.Error())
	}
	target := h.connections[sub.UserID][command.TargetDeviceID]
	if target == nil || !target.announced {
		return immediateResult(command, "offline", ErrTargetOffline.Error())
	}
	if !target.control {
		return immediateResult(command, "rejected", "target device has remote control disabled")
	}
	if command.RequiredCapability != "" {
		if _, ok := target.capabilities[command.RequiredCapability]; !ok {
			return immediateResult(command, "unsupported", ErrTargetUnsupported.Error())
		}
	}

	select {
	case target.subscription.Commands <- command:
		pending := &pendingCommand{command: command}
		pending.timer = time.AfterFunc(h.commandTimeout, func() {
			h.timeoutCommand(sub.UserID, command.CommandID, pending)
		})
		h.pending[key] = pending
		return nil
	default:
		return immediateResult(command, "busy", ErrTargetBusy.Error())
	}
}

func (h *Hub) SendResult(sub *Subscription, result CommandResult) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	connection := h.currentConnectionLocked(sub)
	if connection == nil {
		return false
	}
	return sendResult(connection.subscription, result)
}

func (h *Hub) ResolveCommand(sub *Subscription, status, commandID, errorMessage string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	key := commandKey(sub.UserID, commandID)
	pending := h.pending[key]
	if pending == nil || pending.command.TargetDeviceID != sub.DeviceID {
		return false
	}
	if current := h.currentConnectionLocked(sub); current == nil {
		return false
	}
	pending.timer.Stop()
	delete(h.pending, key)
	result := CommandResult{
		CommandID:      pending.command.CommandID,
		SourceDeviceID: pending.command.SourceDeviceID,
		TargetDeviceID: pending.command.TargetDeviceID,
		Status:         status,
		Error:          strings.TrimSpace(errorMessage),
	}
	h.recordCompletedLocked(key, result)
	return h.sendResultToSourceLocked(sub.UserID, result)
}

func (h *Hub) currentConnectionLocked(sub *Subscription) *deviceConnection {
	connection := h.connections[sub.UserID][sub.DeviceID]
	if connection == nil || connection.subscription.Connection != sub.Connection {
		return nil
	}
	return connection
}

func (h *Hub) timeoutCommand(userID uuid.UUID, commandID string, expected *pendingCommand) {
	h.mu.Lock()
	defer h.mu.Unlock()
	key := commandKey(userID, commandID)
	pending := h.pending[key]
	if pending == nil || pending != expected {
		return
	}
	delete(h.pending, key)
	result := *immediateResult(pending.command, "timeout", "target did not acknowledge command")
	h.recordCompletedLocked(key, result)
	h.sendResultToSourceLocked(userID, result)
}

func (h *Hub) failPendingForTargetLocked(userID uuid.UUID, deviceID, status, message string) {
	for key, pending := range h.pending {
		if pending.command.TargetDeviceID != deviceID || !strings.HasPrefix(key, userID.String()+":") {
			continue
		}
		pending.timer.Stop()
		delete(h.pending, key)
		result := *immediateResult(pending.command, status, message)
		h.recordCompletedLocked(key, result)
		h.sendResultToSourceLocked(userID, result)
	}
}

func (h *Hub) sendResultToSourceLocked(userID uuid.UUID, result CommandResult) bool {
	source := h.connections[userID][result.SourceDeviceID]
	if source == nil {
		return false
	}
	return sendResult(source.subscription, result)
}

func (h *Hub) signalDevicesLocked(userID uuid.UUID) {
	for _, connection := range h.connections[userID] {
		if connection.announced {
			signal(connection.subscription.DeviceChanges)
		}
	}
}

// recordCompletedLocked stores a finished command's result and prunes expired
// entries in the same step. Pruning used to happen only in RouteCommand, so a
// device that resolved or timed out commands but never routed new ones — a
// receiver-only client, or the state after the last controller disconnects —
// left expired entries in the map indefinitely.
func (h *Hub) recordCompletedLocked(key string, result CommandResult) {
	now := time.Now()
	h.pruneCompletedLocked(now)
	h.completed[key] = completedCommand{
		result:    result,
		expiresAt: now.Add(completedCommandTTL),
	}
}

func (h *Hub) pruneCompletedLocked(now time.Time) {
	for key, completed := range h.completed {
		if !completed.expiresAt.After(now) {
			delete(h.completed, key)
		}
	}
}

func immediateResult(command Command, status, message string) *CommandResult {
	return &CommandResult{
		CommandID:      command.CommandID,
		SourceDeviceID: command.SourceDeviceID,
		TargetDeviceID: command.TargetDeviceID,
		Status:         status,
		Error:          message,
	}
}

func sendResult(sub *Subscription, result CommandResult) bool {
	select {
	case sub.Results <- result:
		return true
	default:
		return false
	}
}

func signal(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}

func commandKey(userID uuid.UUID, commandID string) string {
	return userID.String() + ":" + commandID
}
