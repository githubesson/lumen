import { useRef } from "react";
import { createPortal } from "react-dom";
import {
  CheckIcon,
  ComputerDesktopIcon,
  SignalIcon,
  WindowIcon,
  XMarkIcon,
} from "@heroicons/react/16/solid";
import { useRemotePlayback } from "../context/Player";
import { useDismiss } from "../lib/useDismiss";

interface Props {
  open: boolean;
  anchor: HTMLElement | null;
  miniPlayerMode?: boolean;
  onClose: () => void;
}

export default function PlaybackDevicePopover({
  open,
  anchor,
  miniPlayerMode = false,
  onClose,
}: Props) {
  const {
    connected,
    remoteDevices,
    targetDeviceId,
    lastCommandResult,
    selectTarget,
  } = useRemotePlayback();
  const ref = useRef<HTMLDivElement>(null);

  useDismiss(ref, {
    onDismiss: onClose,
    enabled: open,
    capture: true,
    ignore: (target) => !!anchor?.contains(target),
  });

  if (!open || !anchor) return null;

  const rect = anchor.getBoundingClientRect();
  const width = miniPlayerMode
    ? Math.min(300, window.innerWidth - 24)
    : 300;
  const bottom = Math.max(12, window.innerHeight - rect.top + 8);
  const right = Math.max(12, window.innerWidth - rect.right);
  const error =
    lastCommandResult && lastCommandResult.status !== "applied"
      ? lastCommandResult.error || `Command ${lastCommandResult.status}`
      : null;

  return createPortal(
    <div
      ref={ref}
      className="device-pop"
      role="dialog"
      aria-label="Playback device"
      style={{ bottom, right, width }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="device-pop-head">
        <div>
          <div className="device-pop-eyebrow">Connect</div>
          <div className="device-pop-title">Playback device</div>
        </div>
        <span
          className={"device-pop-socket" + (connected ? " online" : "")}
          title={connected ? "WebSocket connected" : "WebSocket reconnecting"}
        >
          <SignalIcon aria-hidden="true" />
          {connected ? "Live" : "Reconnecting"}
        </span>
        <button
          type="button"
          className="iconbtn device-pop-close"
          aria-label="Close device picker"
          onClick={onClose}
        >
          <XMarkIcon className="size-3.5" />
        </button>
      </div>

      <div className="device-pop-body">
        <button
          type="button"
          className={"device-pop-row" + (!targetDeviceId ? " active" : "")}
          onClick={() => {
            selectTarget(null);
            onClose();
          }}
        >
          <span className="device-pop-icon local">
            <WindowIcon aria-hidden="true" />
          </span>
          <span className="device-pop-copy">
            <span className="device-pop-name">This device</span>
            <span className="device-pop-meta">Play locally in this app</span>
          </span>
          {!targetDeviceId && <CheckIcon className="device-pop-check" />}
        </button>

        <div className="device-pop-section">Available devices</div>
        {remoteDevices.length ? (
          remoteDevices.map((device) => {
            const active = targetDeviceId === device.deviceId;
            return (
              <button
                key={device.deviceId}
                type="button"
                className={"device-pop-row" + (active ? " active" : "")}
                onClick={() => {
                  selectTarget(device.deviceId);
                  onClose();
                }}
              >
                <span className="device-pop-icon remote">
                  <ComputerDesktopIcon aria-hidden="true" />
                  <span className="device-pop-online" aria-hidden="true" />
                </span>
                <span className="device-pop-copy">
                  <span className="device-pop-name">{device.deviceName}</span>
                  <span className="device-pop-meta">
                    {device.activity?.title
                      ? `${device.activity.is_playing ? "Playing" : "Paused"} · ${device.activity.title}`
                      : "Online · Nothing playing"}
                  </span>
                </span>
                {active && <CheckIcon className="device-pop-check" />}
              </button>
            );
          })
        ) : (
          <div className="device-pop-empty">
            Open Lumen on another device to control it from here.
          </div>
        )}
      </div>

      {error && (
        <div className="device-pop-error" role="status">
          {error}
        </div>
      )}
    </div>,
    document.body,
  );
}
