import type { AudioStatus } from "expo-audio";
import { diagnosticsLog, type LogEntry } from "./log";

type PlaybackDetails = Record<string, string | number | boolean | null>;

// Never persist native error text or media URLs: either can include credentials.
// These fields are sufficient to distinguish loading, buffering and a real pause.
export function playbackSnapshot(status: AudioStatus) {
  const control = ["playing", "paused", "waitingToPlayAtSpecifiedRate"].includes(status.timeControlStatus)
    ? status.timeControlStatus : "unknown";
  const waiting = ["toMinimizeStalls", "evaluatingBufferingRate", "noItemToPlay"].includes(status.reasonForWaitingToPlay)
    ? status.reasonForWaitingToPlay : "unknown";
  return {
    position: Number.isFinite(status.currentTime) ? status.currentTime : null,
    duration: Number.isFinite(status.duration) ? status.duration : null,
    loaded: status.isLoaded,
    playing: status.playing,
    buffering: status.isBuffering,
    finished: status.didJustFinish,
    control,
    waiting,
    hasError: Boolean(status.error),
    mediaServicesReset: status.mediaServicesDidReset === true,
  };
}

export function recordPlaybackDiagnostic(event: string, details: object): void {
  diagnosticsLog.append({
    scope: "playback",
    level: "info",
    event,
    message: JSON.stringify(details),
  });
}

/** Export only operational playback/session records, excluding download URLs. */
export function formatPlaybackTrace(entries: LogEntry[]): string {
  return entries
    .filter((entry) => entry.scope === "playback" || entry.scope === "session")
    .sort((a, b) => a.at - b.at)
    .map((entry) => JSON.stringify(entry))
    .join("\n");
}

/** Records commands and state changes, not every one-second playback tick. */
export function createPlaybackDiagnostics(readStatus: () => AudioStatus) {
  let lastState = "";
  let lastPosition: number | null = null;
  let progressAt = Date.now();
  let stalled = false;
  let generation = 0;

  const record = (event: string, details: PlaybackDetails = {}, observed?: AudioStatus) => {
    try {
      recordPlaybackDiagnostic(event, {
        generation,
        ...details,
        native: playbackSnapshot(readStatus()),
        ...(observed ? { observed: playbackSnapshot(observed) } : {}),
      });
    } catch {
      // A released native object must not make logging break playback.
    }
  };

  return {
    record,
    source(kind: "local" | "stream", prepared: boolean) {
      generation += 1;
      lastState = "";
      lastPosition = null;
      progressAt = Date.now();
      stalled = false;
      record("audio-source", { kind, prepared });
    },
    observe(status: AudioStatus, pendingStart: boolean, pendingSeek: boolean) {
      const snapshot = playbackSnapshot(status);
      const { position, ...state } = snapshot;
      const key = JSON.stringify({ ...state, pendingStart, pendingSeek });
      if (key !== lastState) {
        lastState = key;
        record("audio-status", { pendingStart, pendingSeek }, status);
      }
      const now = Date.now();
      if (position !== lastPosition) {
        if (stalled) record("audio-progress-resumed", {}, status);
        lastPosition = position;
        progressAt = now;
        stalled = false;
      } else if (!stalled && now - progressAt >= 10_000 &&
        (pendingStart || status.playing || status.isBuffering)) {
        stalled = true;
        record("audio-no-progress", { pendingStart, pendingSeek }, status);
      }
    },
  };
}
