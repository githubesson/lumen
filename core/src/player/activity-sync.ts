import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  getBaseUrl,
  type PlaybackActivity,
  type PlaybackActivityInput,
  type TrackListItem,
} from "../api";
import type { Storage } from "../storage";
import type { AudioAdapter } from "./audio-adapter";
import type {
  PlayerControls,
  PlayerState,
  RepeatMode,
  TimeState,
} from "./player-core";

export const ACTIVITY_DEVICE_ID_STORAGE_KEY = "mlib-activity-device-id";

const PLAYBACK_SYNC_PROTOCOL = 1;
const PLAYING_HEARTBEAT_MS = 10_000;
const PAUSED_HEARTBEAT_MS = 30_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const DEFAULT_PLAYBACK_CAPABILITIES: PlaybackCapability[] = [
  "playback",
  "seek",
  "volume",
  "queue",
];

export type PlaybackCapability = "playback" | "seek" | "volume" | "queue";
export type RemotePlaybackCommandAction =
  | "play_track"
  | "set_playing"
  | "next"
  | "previous"
  | "seek"
  | "set_volume"
  | "set_muted"
  | "set_shuffle"
  | "set_repeat";

export interface RemotePlaybackControlEvent {
  commandId: string;
  sourceDeviceId: string;
  action: RemotePlaybackCommandAction;
  controlledAt: number;
}

export interface PlaybackDevice {
  deviceId: string;
  deviceName: string;
  online: boolean;
  controlEnabled: boolean;
  capabilities: PlaybackCapability[];
  connectedAt: string;
  activity: PlaybackActivity | null;
}

export type RemotePlaybackCommandStatus =
  | "applied"
  | "rejected"
  | "unsupported"
  | "offline"
  | "busy"
  | "pending"
  | "timeout"
  | "disconnected";

export interface RemotePlaybackCommandResult {
  commandId: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  status: RemotePlaybackCommandStatus;
  error?: string;
}

export interface PlaybackRemoteSessionSnapshot {
  deviceId: string | null;
  connected: boolean;
  devices: PlaybackDevice[];
}

type PlaybackActivityListener = (activity: PlaybackActivity | null) => void;
type RemotePlaybackControlListener = (
  event: RemotePlaybackControlEvent,
) => void;

interface PlaybackSyncServerMessage {
  type: "activity.snapshot";
  protocol: number;
  activity: PlaybackActivity | null;
}

interface PlaybackSyncUpdateMessage {
  type: "activity.update";
  protocol: number;
  revision: number;
  activity: PlaybackActivityInput;
}

interface PlaybackSyncClearMessage {
  type: "activity.clear";
  protocol: number;
  revision: number;
  device_id: string;
}

interface PlaybackSyncHelloMessage {
  type: "device.hello";
  protocol: number;
  revision: number;
  device_name: string;
  capabilities: PlaybackCapability[];
  control_enabled: boolean;
}

interface PlaybackSyncCommandResultMessage {
  type: "playback.command_result";
  protocol: number;
  revision: number;
  command_id: string;
  status: "applied" | "rejected" | "unsupported";
  error?: string;
}

interface PlaybackSyncCommandMessage {
  type: "playback.command";
  protocol: number;
  command_id: string;
  source_device_id: string;
  target_device_id: string;
  action: RemotePlaybackCommandAction;
  args?: Record<string, unknown>;
}

interface PlaybackSyncCommandRequestMessage {
  type: "playback.command";
  protocol: number;
  revision: number;
  command_id: string;
  target_device_id: string;
  action: RemotePlaybackCommandAction;
  args: Record<string, unknown>;
}

interface PlaybackSyncDevicesMessage {
  type: "devices.snapshot";
  protocol: number;
  devices: Array<{
    device_id: string;
    device_name: string;
    online: boolean;
    control_enabled: boolean;
    capabilities: PlaybackCapability[];
    connected_at: string;
    activity: PlaybackActivity | null;
  }>;
}

interface PlaybackSyncCommandResponseMessage {
  type: "playback.command_result";
  protocol: number;
  command_id: string;
  source_device_id: string;
  target_device_id: string;
  status: RemotePlaybackCommandStatus;
  error?: string;
}

type PlaybackSyncIncomingMessage =
  | PlaybackSyncServerMessage
  | PlaybackSyncCommandMessage
  | PlaybackSyncDevicesMessage
  | PlaybackSyncCommandResponseMessage;

type PlaybackCommandExecutionResult = Pick<
  PlaybackSyncCommandResultMessage,
  "status" | "error"
>;

const activityListeners = new Set<PlaybackActivityListener>();
const remoteControlListeners = new Set<RemotePlaybackControlListener>();
const remoteSessionListeners = new Set<
  (snapshot: PlaybackRemoteSessionSnapshot) => void
>();
let latestRemoteActivity: PlaybackActivity | null = null;
let hasRemoteSnapshot = false;
let remoteSessionSnapshot: PlaybackRemoteSessionSnapshot = {
  deviceId: null,
  connected: false,
  devices: [],
};
let commandTransport: {
  socket: WebSocket;
  deviceId: string;
  revision: { current: number };
} | null = null;
const pendingCommandResults = new Map<
  string,
  {
    resolve: (result: RemotePlaybackCommandResult) => void;
    timer: ReturnType<typeof setTimeout>;
    targetDeviceId: string;
  }
>();

export interface PlaybackActivityPublisherOptions {
  state: PlayerState;
  time: TimeState;
  storage: Storage;
  deviceName: string;
  adapter?: Pick<AudioAdapter, "on">;
  controls?: PlayerControls;
  capabilities?: PlaybackCapability[];
  controlEnabled?: boolean;
  enabled?: boolean;
}

export async function getOrCreateActivityDeviceId(
  storage: Storage,
): Promise<string> {
  const existing = await storage.getItem(ACTIVITY_DEVICE_ID_STORAGE_KEY);
  if (existing) return existing;
  const next = createDeviceId();
  await storage.setItem(ACTIVITY_DEVICE_ID_STORAGE_KEY, next);
  return next;
}

/** Subscribe to the freshest activity from another device in this runtime. */
export function subscribePlaybackActivity(
  listener: PlaybackActivityListener,
): () => void {
  activityListeners.add(listener);
  if (hasRemoteSnapshot) listener(latestRemoteActivity);
  return () => activityListeners.delete(listener);
}

/** Read the most recent server snapshot without waiting for another event. */
export function getLatestPlaybackActivity(): PlaybackActivity | null {
  return hasRemoteSnapshot ? latestRemoteActivity : null;
}

/** Subscribe to commands successfully applied by another device. */
export function subscribeRemotePlaybackControl(
  listener: RemotePlaybackControlListener,
): () => void {
  remoteControlListeners.add(listener);
  return () => remoteControlListeners.delete(listener);
}

export function subscribePlaybackRemoteSession(
  listener: (snapshot: PlaybackRemoteSessionSnapshot) => void,
): () => void {
  remoteSessionListeners.add(listener);
  listener(remoteSessionSnapshot);
  return () => remoteSessionListeners.delete(listener);
}

export function usePlaybackRemoteSession(): PlaybackRemoteSessionSnapshot {
  const [snapshot, setSnapshot] = useState(remoteSessionSnapshot);
  useEffect(() => subscribePlaybackRemoteSession(setSnapshot), []);
  return snapshot;
}

export function sendRemotePlaybackCommand(
  targetDeviceId: string,
  action: RemotePlaybackCommandAction,
  args: Record<string, unknown> = {},
): Promise<RemotePlaybackCommandResult> {
  const transport = commandTransport;
  const commandId = createCommandId();
  if (!transport || transport.socket.readyState !== WebSocket.OPEN) {
    return Promise.resolve({
      commandId,
      sourceDeviceId: remoteSessionSnapshot.deviceId ?? "",
      targetDeviceId,
      status: "disconnected",
      error: "playback socket is disconnected",
    });
  }

  const sent = sendSocketMessage(transport.socket, {
    type: "playback.command",
    protocol: PLAYBACK_SYNC_PROTOCOL,
    revision: ++transport.revision.current,
    command_id: commandId,
    target_device_id: targetDeviceId,
    action,
    args,
  });
  if (!sent) {
    return Promise.resolve({
      commandId,
      sourceDeviceId: transport.deviceId,
      targetDeviceId,
      status: "disconnected",
      error: "could not send playback command",
    });
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCommandResults.delete(commandId);
      resolve({
        commandId,
        sourceDeviceId: transport.deviceId,
        targetDeviceId,
        status: "timeout",
        error: "playback command result was not received",
      });
    }, 12_000);
    pendingCommandResults.set(commandId, { resolve, timer, targetDeviceId });
  });
}

export function usePlaybackActivityPublisher({
  state,
  time,
  storage,
  deviceName,
  adapter,
  controls,
  capabilities = DEFAULT_PLAYBACK_CAPABILITIES,
  controlEnabled = !!controls,
  enabled = true,
}: PlaybackActivityPublisherOptions): string | null {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  // Stable identity for the capability list, so the socket effect below can
  // depend on the *contents* rather than the array reference.
  const capabilitiesKey = capabilities.join(",");
  const capabilitiesRef = useRef(capabilities);
  useEffect(() => {
    capabilitiesRef.current = capabilities;
  }, [capabilities]);
  const stateRef = useRef(state);
  const timeRef = useRef(time);
  const socketRef = useRef<WebSocket | null>(null);
  const revisionRef = useRef(0);
  const publishedRef = useRef(false);
  const publishRef = useRef<() => void>(() => {});
  const controlsRef = useRef(controls);
  const commandQueueRef = useRef(Promise.resolve());
  const processedCommandsRef = useRef(
    new Map<string, PlaybackCommandExecutionResult>(),
  );

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    timeRef.current = time;
  }, [time]);

  useEffect(() => {
    controlsRef.current = controls;
  }, [controls]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void getOrCreateActivityDeviceId(storage).then((id) => {
      if (!cancelled) {
        setDeviceId(id);
        updateRemoteSession({ deviceId: id });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, storage]);

  const publish = useCallback(() => {
    if (!enabled || !deviceId) return;
    const payload = buildActivityPayload(
      deviceId,
      deviceName,
      stateRef.current.current,
      stateRef.current.isPlaying,
      stateRef.current.volume,
      stateRef.current.muted,
      timeRef.current,
    );
    const revision = ++revisionRef.current;
    if (!payload) {
      if (!publishedRef.current) return;
      publishedRef.current = false;
      const sent = sendSocketMessage(socketRef.current, {
        type: "activity.clear",
        protocol: PLAYBACK_SYNC_PROTOCOL,
        revision,
        device_id: deviceId,
      });
      if (!sent) void api.clearPlaybackActivity(deviceId).catch(() => {});
      return;
    }

    publishedRef.current = true;
    const sent = sendSocketMessage(socketRef.current, {
      type: "activity.update",
      protocol: PLAYBACK_SYNC_PROTOCOL,
      revision,
      activity: payload,
    });
    // REST remains a compatibility path while the socket connects or when an
    // older deployment proxy does not yet support WebSocket upgrades.
    if (!sent) void api.upsertPlaybackActivity(payload).catch(() => {});
  }, [deviceId, deviceName, enabled]);

  // Keep the ref current from an effect: writing refs during render is
  // illegal under concurrent React (and rejected by the React Compiler).
  useEffect(() => {
    publishRef.current = publish;
  }, [publish]);

  useEffect(() => {
    if (!enabled || !deviceId) return;
    const endpoint = playbackSocketURL(deviceId);
    if (!endpoint) return;

    latestRemoteActivity = null;
    hasRemoteSnapshot = false;

    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = () => {
      if (disposed) return;
      const socket = new WebSocket(endpoint);
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) {
          socket.close(1000, "disposed");
          return;
        }
        attempt = 0;
        commandTransport = { socket, deviceId, revision: revisionRef };
        updateRemoteSession({ connected: true });
        if (controlsRef.current) {
          sendSocketMessage(socket, {
            type: "device.hello",
            protocol: PLAYBACK_SYNC_PROTOCOL,
            revision: ++revisionRef.current,
            device_name: deviceName,
            capabilities: capabilitiesRef.current,
            control_enabled: controlEnabled,
          });
        }
        publishRef.current();
      };
      socket.onmessage = (event) => {
        const message = parseServerMessage(event.data);
        if (!message) return;
        if (message.type === "activity.snapshot") {
          latestRemoteActivity = message.activity;
          hasRemoteSnapshot = true;
          for (const listener of activityListeners) {
            try {
              listener(message.activity);
            } catch {
              // A platform integration must not break delivery to other
              // subscribers or the socket's reconnect lifecycle.
            }
          }
          return;
        }
        if (message.type === "playback.command") {
          commandQueueRef.current = commandQueueRef.current.then(() =>
            handlePlaybackCommand(
              socket,
              message,
              deviceId,
              stateRef.current,
              controlsRef.current,
              revisionRef,
              processedCommandsRef.current,
            ),
          );
          return;
        }
        if (message.type === "devices.snapshot") {
          updateRemoteSession({ devices: normalizeDevices(message.devices) });
          return;
        }
        if (message.type === "playback.command_result") {
          resolveRemoteCommandResult(message);
        }
      };
      socket.onerror = () => {
        // onclose owns reconnect scheduling; browsers intentionally expose
        // very little detail for WebSocket handshake failures.
      };
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (commandTransport?.socket === socket) {
          commandTransport = null;
          updateRemoteSession({ connected: false, devices: [] });
          failPendingCommands("playback socket disconnected");
        }
        if (disposed) return;
        const exponential = Math.min(
          RECONNECT_MAX_MS,
          RECONNECT_BASE_MS * 2 ** attempt++,
        );
        const jittered = exponential * (0.75 + Math.random() * 0.5);
        retryTimer = setTimeout(connect, jittered);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (socketRef.current) {
        socketRef.current.close(1000, "player disposed");
        socketRef.current = null;
      }
      latestRemoteActivity = null;
      hasRemoteSnapshot = false;
      if (commandTransport?.deviceId === deviceId) {
        commandTransport = null;
        updateRemoteSession({ connected: false, devices: [] });
        failPendingCommands("playback socket disconnected");
      }
    };
    // capabilitiesKey, not `capabilities`: a caller passing an inline array
    // literal creates a new identity every render, which would tear down and
    // re-open the WebSocket each time.
  }, [capabilitiesKey, controlEnabled, deviceId, deviceName, enabled]);

  useEffect(() => {
    publish();
  }, [
    publish,
    state.current?.id,
    state.isPlaying,
    state.volume,
    state.muted,
  ]);

  useEffect(() => {
    if (!adapter) return;
    return adapter.on("seeked", publish);
  }, [adapter, publish]);

  const hasCurrentTrack = state.current != null;
  useEffect(() => {
    if (!enabled || !deviceId || !hasCurrentTrack) return;
    const delay = state.isPlaying ? PLAYING_HEARTBEAT_MS : PAUSED_HEARTBEAT_MS;
    const interval = setInterval(publish, delay);
    return () => clearInterval(interval);
  }, [deviceId, enabled, hasCurrentTrack, publish, state.isPlaying]);

  useEffect(() => {
    return () => {
      if (deviceId && publishedRef.current) {
        // Socket teardown can race its closing handshake, so the REST delete
        // remains the best-effort unload cleanup. The server lease is the
        // authoritative fallback if the platform suspends networking first.
        void api.clearPlaybackActivity(deviceId).catch(() => {});
      }
    };
  }, [deviceId]);

  return deviceId;
}

function buildActivityPayload(
  deviceId: string,
  deviceName: string,
  track: TrackListItem | null,
  isPlaying: boolean,
  volume: number,
  muted: boolean,
  time: TimeState,
): PlaybackActivityInput | null {
  if (!track) return null;
  const durationSec =
    time.duration > 0
      ? Math.round(time.duration)
      : Math.round((track.duration_ms || 0) / 1000);
  return {
    device_id: deviceId,
    device_name: deviceName,
    track_id: track.id,
    title: track.title,
    artist: track.artist || undefined,
    album: track.album_title || undefined,
    album_id: track.album_id || undefined,
    cover_url: track.cover_url || undefined,
    duration_sec: durationSec > 0 ? durationSec : undefined,
    position_sec: Math.max(0, Math.floor(time.currentTime || 0)),
    is_playing: isPlaying,
    volume: Math.max(0, Math.min(1, volume)),
    muted,
  };
}

function sendSocketMessage(
  socket: WebSocket | null,
  message:
    | PlaybackSyncUpdateMessage
    | PlaybackSyncClearMessage
    | PlaybackSyncHelloMessage
    | PlaybackSyncCommandResultMessage
    | PlaybackSyncCommandRequestMessage,
): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function parseServerMessage(data: unknown): PlaybackSyncIncomingMessage | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as Partial<PlaybackSyncIncomingMessage>;
    if (parsed.protocol !== PLAYBACK_SYNC_PROTOCOL) {
      return null;
    }
    if (
      parsed.type === "activity.snapshot" &&
      (parsed.activity === null || typeof parsed.activity === "object")
    ) {
      return parsed as PlaybackSyncServerMessage;
    }
    if (
      parsed.type === "playback.command" &&
      typeof parsed.command_id === "string" &&
      typeof parsed.source_device_id === "string" &&
      typeof parsed.target_device_id === "string" &&
      isRemoteCommandAction(parsed.action)
    ) {
      return parsed as PlaybackSyncCommandMessage;
    }
    if (parsed.type === "devices.snapshot") {
      if (!Array.isArray(parsed.devices)) return null;
      return parsed as PlaybackSyncDevicesMessage;
    }
    if (
      parsed.type === "playback.command_result" &&
      typeof parsed.command_id === "string" &&
      typeof parsed.source_device_id === "string" &&
      typeof parsed.target_device_id === "string" &&
      isRemoteCommandStatus(parsed.status)
    ) {
      return parsed as PlaybackSyncCommandResponseMessage;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeDevices(
  devices: PlaybackSyncDevicesMessage["devices"],
): PlaybackDevice[] {
  return devices
    .filter(
      (device) =>
        typeof device?.device_id === "string" &&
        typeof device.device_name === "string" &&
        Array.isArray(device.capabilities),
    )
    .map((device) => ({
      deviceId: device.device_id,
      deviceName: device.device_name,
      online: device.online === true,
      controlEnabled: device.control_enabled === true,
      capabilities: device.capabilities.filter(isPlaybackCapability),
      connectedAt:
        typeof device.connected_at === "string" ? device.connected_at : "",
      activity:
        device.activity && typeof device.activity === "object"
          ? device.activity
          : null,
    }));
}

function updateRemoteSession(
  patch: Partial<PlaybackRemoteSessionSnapshot>,
): void {
  remoteSessionSnapshot = { ...remoteSessionSnapshot, ...patch };
  for (const listener of remoteSessionListeners) {
    try {
      listener(remoteSessionSnapshot);
    } catch {
      // One view cannot block presence updates for the rest of the runtime.
    }
  }
}

function resolveRemoteCommandResult(
  message: PlaybackSyncCommandResponseMessage,
): void {
  if (message.status === "pending") return;
  const pending = pendingCommandResults.get(message.command_id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingCommandResults.delete(message.command_id);
  pending.resolve({
    commandId: message.command_id,
    sourceDeviceId: message.source_device_id,
    targetDeviceId: message.target_device_id,
    status: message.status,
    error: message.error,
  });
}

function failPendingCommands(error: string): void {
  for (const [commandId, pending] of pendingCommandResults) {
    clearTimeout(pending.timer);
    pending.resolve({
      commandId,
      sourceDeviceId: remoteSessionSnapshot.deviceId ?? "",
      targetDeviceId: pending.targetDeviceId,
      status: "disconnected",
      error,
    });
  }
  pendingCommandResults.clear();
}

function isPlaybackCapability(value: unknown): value is PlaybackCapability {
  return (
    value === "playback" ||
    value === "seek" ||
    value === "volume" ||
    value === "queue"
  );
}

function isRemoteCommandStatus(
  value: unknown,
): value is RemotePlaybackCommandStatus {
  return (
    value === "applied" ||
    value === "rejected" ||
    value === "unsupported" ||
    value === "offline" ||
    value === "busy" ||
    value === "pending" ||
    value === "timeout" ||
    // Part of the RemotePlaybackCommandStatus union; omitting it here made a
    // legitimate "disconnected" result fail validation.
    value === "disconnected"
  );
}

async function handlePlaybackCommand(
  socket: WebSocket,
  message: PlaybackSyncCommandMessage,
  deviceId: string,
  state: PlayerState,
  controls: PlayerControls | undefined,
  revision: { current: number },
  processed: Map<string, PlaybackCommandExecutionResult>,
): Promise<void> {
  if (message.target_device_id !== deviceId) return;

  let result = processed.get(message.command_id);
  const isFirstDelivery = !result;
  if (!result) {
    result = executePlaybackCommand(message, state, controls);
    processed.set(message.command_id, result);
    if (processed.size > 128) {
      const oldest = processed.keys().next().value;
      if (oldest) processed.delete(oldest);
    }
  }

  sendSocketMessage(socket, {
    type: "playback.command_result",
    protocol: PLAYBACK_SYNC_PROTOCOL,
    revision: ++revision.current,
    command_id: message.command_id,
    status: result.status,
    error: result.error,
  });

  if (isFirstDelivery && result.status === "applied") {
    const event: RemotePlaybackControlEvent = {
      commandId: message.command_id,
      sourceDeviceId: message.source_device_id,
      action: message.action,
      controlledAt: Date.now(),
    };
    for (const listener of remoteControlListeners) {
      try {
        listener(event);
      } catch {
        // UI observers cannot interfere with command acknowledgement.
      }
    }
  }
}

function executePlaybackCommand(
  message: PlaybackSyncCommandMessage,
  state: PlayerState,
  controls: PlayerControls | undefined,
): PlaybackCommandExecutionResult {
  if (!controls) {
    return { status: "unsupported", error: "remote control is unavailable" };
  }
  const args = message.args ?? {};
  try {
    switch (message.action) {
      case "play_track":
        controls.play(commandTrack(args, "track"), commandTrackQueue(args));
        break;
      case "set_playing": {
        const playing = commandBoolean(args, "playing");
        if (playing && !state.current) {
          return { status: "rejected", error: "nothing is loaded" };
        }
        if (playing) controls.resume();
        else controls.pause();
        break;
      }
      case "next":
        if (!state.queue.length) {
          return { status: "rejected", error: "queue is empty" };
        }
        controls.next();
        break;
      case "previous":
        if (!state.current) {
          return { status: "rejected", error: "nothing is loaded" };
        }
        controls.prev();
        break;
      case "seek":
        if (!state.current) {
          return { status: "rejected", error: "nothing is loaded" };
        }
        controls.seek(commandNumber(args, "position_sec"));
        break;
      case "set_volume":
        controls.setVolume(commandNumber(args, "volume"));
        break;
      case "set_muted":
        controls.setMuted(commandBoolean(args, "muted"));
        break;
      case "set_shuffle":
        controls.setShuffle(commandBoolean(args, "shuffle"));
        break;
      case "set_repeat":
        controls.setRepeat(commandRepeat(args));
        break;
    }
    return { status: "applied" };
  } catch (error) {
    return {
      status: "rejected",
      error: error instanceof Error ? error.message : "invalid command",
    };
  }
}

function commandBoolean(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (typeof value !== "boolean") throw new Error(`${key} must be boolean`);
  return value;
}

function commandTrack(
  args: Record<string, unknown>,
  key: string,
): TrackListItem {
  const value = args[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} must be a track`);
  }
  const track = value as Partial<TrackListItem>;
  if (
    typeof track.id !== "string" ||
    !track.id ||
    typeof track.title !== "string" ||
    typeof track.duration_ms !== "number" ||
    !Number.isFinite(track.duration_ms)
  ) {
    throw new Error(`${key} is invalid`);
  }
  return track as TrackListItem;
}

function commandTrackQueue(args: Record<string, unknown>): TrackListItem[] {
  if (!Array.isArray(args.queue)) throw new Error("queue must be an array");
  return args.queue.map((track, index) => {
    const key = `queue[${index}]`;
    return commandTrack({ [key]: track }, key);
  });
}

function commandNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function commandRepeat(args: Record<string, unknown>): RepeatMode {
  const value = args.repeat;
  if (value !== "off" && value !== "all" && value !== "one") {
    throw new Error("repeat must be off, all, or one");
  }
  return value;
}

function isRemoteCommandAction(
  action: unknown,
): action is RemotePlaybackCommandAction {
  return (
    action === "play_track" ||
    action === "set_playing" ||
    action === "next" ||
    action === "previous" ||
    action === "seek" ||
    action === "set_volume" ||
    action === "set_muted" ||
    action === "set_shuffle" ||
    action === "set_repeat"
  );
}

function playbackSocketURL(deviceId: string): string | null {
  const configuredBase = getBaseUrl();
  const runtimeLocation = globalThis.location;
  const base = configuredBase || runtimeLocation?.origin;
  if (!base) return null;
  try {
    const endpoint = new URL("/api/activity/ws", base);
    if (endpoint.protocol === "https:") endpoint.protocol = "wss:";
    else if (endpoint.protocol === "http:") endpoint.protocol = "ws:";
    else return null;
    endpoint.searchParams.set("device_id", deviceId);
    return endpoint.toString();
  } catch {
    return null;
  }
}

function createDeviceId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && "randomUUID" in cryptoObj) {
    return cryptoObj.randomUUID();
  }
  return `device-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}

function createCommandId(): string {
  const cryptoObj = globalThis.crypto as
    | {
        randomUUID?: () => string;
        getRandomValues?: (array: Uint8Array) => Uint8Array;
      }
    | undefined;
  if (typeof cryptoObj?.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof cryptoObj?.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
