import { Platform } from "react-native";
import { after, type LiveActivity } from "expo-widgets";
import type { TrackListItem } from "@music-library/core";
import {
  DownloadActivity,
  type DownloadActivityProps,
} from "../../widgets/download-live-activity";

/** Min gap between byte-progress pushes; count beats always go through. */
const UPDATE_THROTTLE_MS = 1000;
/** How long the done/partial summary stays on the lock screen. */
const END_DISMISS_MS = 4000;

interface Session {
  /** For the merged title when a second playlist starts mid-download. */
  playlistNames: string[];
  /** Tracks queued this session (only ones that weren't already stored). */
  tracks: Map<string, TrackListItem>;
  completed: Set<string>;
  failed: Set<string>;
  /** Per-track byte fraction 0..1 — only advances while foregrounded. */
  byteProgress: Map<string, number>;
  currentTrackTitle: string;
  lastPushAt: number;
  /** Null when the user has Live Activities disabled or dismissed this one. */
  instance: LiveActivity<DownloadActivityProps> | null;
}

let session: Session | null = null;

function snapshot(phase: DownloadActivityProps["phase"]): DownloadActivityProps {
  const s = session!;
  const total = s.tracks.size;
  let inFlight = 0;
  for (const fraction of s.byteProgress.values()) inFlight += fraction;
  const settled = s.completed.size + s.failed.size;
  return {
    title:
      s.playlistNames.length === 1
        ? s.playlistNames[0]
        : `${s.playlistNames.length} playlists`,
    totalTracks: total,
    completedTracks: s.completed.size,
    failedTracks: s.failed.size,
    currentTrackTitle: phase === "downloading" ? s.currentTrackTitle : "",
    progress: total === 0 ? 0 : Math.min(1, (settled + inFlight) / total),
    phase,
  };
}

/** An update rejection means the activity is gone (user swiped it away);
 *  drop the handle so the rest of the session runs silently. */
function push(force: boolean): void {
  if (!session?.instance) return;
  const now = Date.now();
  if (!force && now - session.lastPushAt < UPDATE_THROTTLE_MS) return;
  session.lastPushAt = now;
  const instance = session.instance;
  instance.update(snapshot("downloading")).catch(() => {
    if (session?.instance === instance) session.instance = null;
  });
}

function settle(trackId: string, bucket: "completed" | "failed"): void {
  if (!session?.tracks.has(trackId)) return;
  if (session.completed.has(trackId) || session.failed.has(trackId)) return;
  session[bucket].add(trackId);
  session.byteProgress.delete(trackId);
  if (session.completed.size + session.failed.size >= session.tracks.size) {
    const phase = session.failed.size === 0 ? "done" : "partial";
    session.instance
      ?.end(after(new Date(Date.now() + END_DISMISS_MS)), snapshot(phase))
      .catch(() => {});
    session = null;
    return;
  }
  // Count beats push unthrottled — they're the only updates that land while
  // the app is woken in the background for finished download tasks.
  push(true);
}

/**
 * Bridges the download store to the iOS Live Activity. Owns the notion of a
 * "download session": everything queued between the first `begin` and the
 * moment all of it settles is one activity. The store calls `begin` /
 * `noteProgress` / `noteDone` / `noteFailed` / `clearOrphaned`; everything
 * here no-ops on Android and degrades silently when Live Activities are
 * unavailable, disabled, or dismissed — downloads never depend on it.
 */
export const downloadLiveActivity = {
  /** Call with the tracks that will actually download (already-stored ones
   *  filtered out). Merges into the running session if one exists. */
  begin(playlistName: string, tracks: TrackListItem[]): void {
    if (Platform.OS !== "ios" || tracks.length === 0) return;
    if (session) {
      for (const track of tracks) {
        if (!session.tracks.has(track.id)) session.tracks.set(track.id, track);
      }
      if (!session.playlistNames.includes(playlistName)) {
        session.playlistNames.push(playlistName);
      }
      push(true);
      return;
    }
    session = {
      playlistNames: [playlistName],
      tracks: new Map(tracks.map((track) => [track.id, track])),
      completed: new Set(),
      failed: new Set(),
      byteProgress: new Map(),
      currentTrackTitle: "",
      lastPushAt: 0,
      instance: null,
    };
    try {
      // Throws when Live Activities are unsupported or disabled in Settings
      // (expo-widgets exposes no capability probe) — null instance makes the
      // whole session a silent no-op.
      session.instance = DownloadActivity.start(snapshot("downloading"));
    } catch {
      session.instance = null;
    }
  },

  noteProgress(trackId: string, bytesDownloaded: number, bytesTotal: number): void {
    if (!session?.tracks.has(trackId)) return;
    if (session.completed.has(trackId) || session.failed.has(trackId)) return;
    if (bytesTotal > 0) {
      session.byteProgress.set(trackId, Math.min(1, bytesDownloaded / bytesTotal));
    }
    session.currentTrackTitle = session.tracks.get(trackId)?.title ?? "";
    push(false);
  },

  noteDone(trackId: string): void {
    settle(trackId, "completed");
  },

  noteFailed(trackId: string): void {
    settle(trackId, "failed");
  },

  /** Hydrate-time sweep: a process kill orphans the previous run's activity
   *  (downloads re-attach, but the session context is gone) — end it rather
   *  than leave a frozen "downloading" card on the lock screen. */
  clearOrphaned(): void {
    if (Platform.OS !== "ios" || session) return;
    try {
      for (const instance of DownloadActivity.getInstances()) {
        instance.end("immediate").catch(() => {});
      }
    } catch {
      // Same silent contract as everything else here.
    }
  },
};
