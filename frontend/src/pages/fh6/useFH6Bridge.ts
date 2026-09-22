import { useCallback, useRef, useState } from "react";
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
  const [queue, setQueue] = useState<FH6QueueTrack[]>([]);
  const [sourceDraft, setSourceDraft] = useState<SourceDraft>(DEFAULT_SOURCE_DRAFT);
  const [sourceDirty, setSourceDirty] = useState(false);
  const sourceDirtyRef = useRef(false);

  const refreshBridge = useCallback(
    async (showError = true) => {
      try {
        const [nextState, nextConfig, nextQueue] = await Promise.all([
          bridgeGet<FH6BridgeState>(bridgeUrl, "/api/state"),
          bridgeGet<BridgeConfig>(bridgeUrl, "/api/config"),
          bridgeGet<BridgeQueue>(bridgeUrl, "/api/source/lumen/queue"),
        ]);
        setState(nextState);
        publishFH6Snapshot({
          bridgeUrl,
          state: nextState,
          queue: nextQueue.tracks ?? [],
          currentIndex: nextQueue.current_index ?? 0,
        });
        setConfig(nextConfig);
        if (!sourceDirtyRef.current) setSourceDraft(configToSourceDraft(nextConfig));
        setQueue(nextQueue.tracks ?? []);
        if (showError) setError(null);
      } catch (e) {
        setState(null);
        publishFH6Snapshot({ bridgeUrl, state: null });
        if (showError) setError((e as Error).message);
      }
    },
    [bridgeUrl, setError],
  );

  function updateSourceDraft(patch: Partial<SourceDraft>): SourceDraft {
    const next = { ...sourceDraft, ...patch };
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

function configToSourceDraft(config: BridgeConfig | null): SourceDraft {
  return {
    queue_mode: config?.lumen?.queue_mode ?? DEFAULT_SOURCE_DRAFT.queue_mode,
    playlist_id: config?.lumen?.playlist_id ?? DEFAULT_SOURCE_DRAFT.playlist_id,
    search: config?.lumen?.search ?? DEFAULT_SOURCE_DRAFT.search,
    limit: config?.lumen?.limit ?? DEFAULT_SOURCE_DRAFT.limit,
  };
}
