import { useEffect, useState } from "react";
import {
  subscribeRemotePlaybackControl,
  type RemotePlaybackControlEvent,
} from "./activity-sync";

/** How long the "controlled from another device" notice stays up after a command. */
export const REMOTE_CONTROL_INDICATOR_MS = 6_000;

/**
 * The latest command another device applied to this player, cleared once
 * `visibleMs` passes without a newer one. Each command restarts the timer, so
 * a burst keeps a single notice up instead of flashing it.
 */
export function useRemoteControlIndicator(
  visibleMs = REMOTE_CONTROL_INDICATOR_MS,
): RemotePlaybackControlEvent | null {
  const [event, setEvent] = useState<RemotePlaybackControlEvent | null>(null);

  useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeRemotePlaybackControl((nextEvent) => {
      if (hideTimer) clearTimeout(hideTimer);
      setEvent(nextEvent);
      hideTimer = setTimeout(() => {
        hideTimer = null;
        setEvent(null);
      }, visibleMs);
    });
    return () => {
      unsubscribe();
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, [visibleMs]);

  return event;
}
