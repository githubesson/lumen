import { useEffect, useRef, useState } from "react";
import { DevicePhoneMobileIcon } from "@heroicons/react/16/solid";
import {
  subscribeRemotePlaybackControl,
  type RemotePlaybackControlEvent,
} from "@music-library/core";

const INDICATOR_VISIBLE_MS = 6_000;

export default function RemoteControlIndicator() {
  const [event, setEvent] = useState<RemotePlaybackControlEvent | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return subscribeRemotePlaybackControl((nextEvent) => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      setEvent(nextEvent);
      hideTimerRef.current = setTimeout(() => {
        hideTimerRef.current = null;
        setEvent(null);
      }, INDICATOR_VISIBLE_MS);
    });
  }, []);

  useEffect(
    () => () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    },
    [],
  );

  if (!event) return null;

  return (
    <div
      key={event.commandId}
      className="remote-control-indicator"
      role="status"
      aria-live="polite"
      title={`Remote ${event.action.replaceAll("_", " ")}`}
    >
      <DevicePhoneMobileIcon aria-hidden="true" />
      <span>Controlled from another device</span>
    </div>
  );
}
