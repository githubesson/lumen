import { useCallback, useEffect, useRef, useState } from "react";
import {
  bridgeGet,
  publishFH6Snapshot,
  type FH6BridgeState,
  type FH6QueueTrack,
} from "../../lib/fh6";

export type QueueMode = "tracks" | "favorites" | "recent" | "playlist";

export interface BridgeConfig {
  lumen?: {
    queue_mode?: QueueMode;
    playlist_id?: string;
    search?: string;
    shuffle?: boolean;
    limit?: number;
  };
  audio?: {
    output_gain?: number;
  };
}

interface BridgeQueue {
  tracks: FH6QueueTrack[];
  current_index?: number;
}

export interface SourceDraft {
  queue_mode: QueueMode;
  playlist_id: string;
  search: string;
  limit: number;
}

const DEFAULT_SOURCE_DRAFT: SourceDraft = {
  queue_mode: "tracks",
  playlist_id: "",
  search: "",
  limit: 500,
};

const EMPTY_QUEUE: FH6QueueTrack[] = [];

/** What the last poll put in state and published, for the next to diff against. */
interface AppliedPoll {
  bridgeUrl: string;
  state: FH6BridgeState | null;
  config: BridgeConfig | null;
  queue: FH6QueueTrack[];
  currentIndex: number;
}

/**
 * Live view of the FH6 bridge (state, config, Lumen source queue) plus the
 * user's editable source draft. `refreshBridge` overwrites the draft from the
 * bridge config only while the user has no unapplied edits.
 *
 * `refreshBridge` is memoized on `bridgeUrl`, so callers can use it as the
 * dependency that restarts polling when the bridge moves.
 */
export function useFH6Bridge(
  bridgeUrl: string,
  setError: (message: string | null) => void,
) {
  const [state, setState] = useState<FH6BridgeState | null>(null);
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const [queue, setQueue] = useState<FH6QueueTrack[]>(EMPTY_QUEUE);
  const [sourceDraft, setSourceDraft] = useState<SourceDraft>(DEFAULT_SOURCE_DRAFT);
  const [sourceDirty, setSourceDirty] = useState(false);
  const sourceDirtyRef = useRef(false);
  // The draft last set, so a poll can compare against it without an update.
  const sourceDraftRef = useRef(DEFAULT_SOURCE_DRAFT);

  // The page polls every 2.5s and an idle bridge answers the same thing each
  // time. Only what changed is set or published: an unchanged poll re-renders
  // neither this page nor (through the snapshot event) the player bar, and a
  // new track position alone republishes the same queue array (up to 1,000
  // tracks) rather than a fresh copy.
  const appliedRef = useRef<AppliedPoll | null>(null);
  // The page publishes `null` when its effects are torn down. Fast Refresh
  // does that while keeping refs, so forget the last poll too, or an
  // unchanged one would never publish again.
  useEffect(
    () => () => {
      appliedRef.current = null;
    },
    [],
  );

  const refreshBridge = useCallback(
    async (showError = true) => {
      try {
        const [fetchedState, fetchedConfig, fetchedQueue] = await Promise.all([
          bridgeGet<FH6BridgeState>(bridgeUrl, "/api/state"),
          bridgeGet<BridgeConfig>(bridgeUrl, "/api/config"),
          bridgeGet<BridgeQueue>(bridgeUrl, "/api/source/lumen/queue"),
        ]);
        const prev = appliedRef.current;
        // Unchanged values keep the objects already in state and published.
        const nextState =
          prev?.state && jsonEqual(prev.state, fetchedState) ? prev.state : fetchedState;
        const nextConfig =
          prev?.config && jsonEqual(prev.config, fetchedConfig) ? prev.config : fetchedConfig;
        const fetchedTracks = fetchedQueue.tracks ?? EMPTY_QUEUE;
        const nextQueue =
          prev && jsonEqual(prev.queue, fetchedTracks) ? prev.queue : fetchedTracks;
        const currentIndex = fetchedQueue.current_index ?? 0;
        appliedRef.current = {
          bridgeUrl,
          state: nextState,
          config: nextConfig,
          queue: nextQueue,
          currentIndex,
        };

        if (nextState !== prev?.state) setState(nextState);
        if (
          !prev ||
          prev.bridgeUrl !== bridgeUrl ||
          nextState !== prev.state ||
          nextQueue !== prev.queue ||
          currentIndex !== prev.currentIndex
        ) {
          publishFH6Snapshot({
            bridgeUrl,
            state: nextState,
            queue: nextQueue,
            currentIndex,
          });
        }
        if (nextConfig !== prev?.config) setConfig(nextConfig);
        // Against the draft, not the last config: an applied draft the bridge
        // clamped (a limit over 1,000) still resets to what it stored.
        if (!sourceDirtyRef.current) {
          const draft = configToSourceDraft(nextConfig);
          if (!jsonEqual(sourceDraftRef.current, draft)) {
            sourceDraftRef.current = draft;
            setSourceDraft(draft);
          }
        }
        if (nextQueue !== prev?.queue) setQueue(nextQueue);
        if (showError) setError(null);
      } catch (e) {
        const prev = appliedRef.current;
        // A bridge that stays down (FH6 not running) publishes its absence once.
        if (!prev || prev.state !== null || prev.bridgeUrl !== bridgeUrl) {
          appliedRef.current = {
            bridgeUrl,
            state: null,
            config: prev?.config ?? null,
            queue: prev?.queue ?? EMPTY_QUEUE,
            currentIndex: prev?.currentIndex ?? 0,
          };
          setState(null);
          publishFH6Snapshot({ bridgeUrl, state: null });
        }
        if (showError) setError((e as Error).message);
      }
    },
    [bridgeUrl, setError],
  );

  function updateSourceDraft(patch: Partial<SourceDraft>): SourceDraft {
    const next = { ...sourceDraft, ...patch };
    sourceDraftRef.current = next;
    sourceDirtyRef.current = true;
    setSourceDirty(true);
    setSourceDraft(next);
    return next;
  }

  function markSourceApplied() {
    sourceDirtyRef.current = false;
    setSourceDirty(false);
  }

  /** Reads the dirty flag synchronously, ahead of the next render. */
  function hasUnappliedSource() {
    return sourceDirtyRef.current;
  }

  return {
    state,
    config,
    queue,
    refreshBridge,
    sourceDraft,
    sourceDirty,
    updateSourceDraft,
    markSourceApplied,
    hasUnappliedSource,
  };
}

/** Structural equality for parsed JSON (plain objects, arrays, primitives). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = Object.keys(ra);
  if (keys.length !== Object.keys(rb).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(rb, key) || !jsonEqual(ra[key], rb[key])) return false;
  }
  return true;
}

function configToSourceDraft(config: BridgeConfig | null): SourceDraft {
  return {
    queue_mode: config?.lumen?.queue_mode ?? DEFAULT_SOURCE_DRAFT.queue_mode,
    playlist_id: config?.lumen?.playlist_id ?? DEFAULT_SOURCE_DRAFT.playlist_id,
    search: config?.lumen?.search ?? DEFAULT_SOURCE_DRAFT.search,
    limit: config?.lumen?.limit ?? DEFAULT_SOURCE_DRAFT.limit,
  };
}
