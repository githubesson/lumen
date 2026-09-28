import { useRef } from "react";
import { createPortal } from "react-dom";
import {
  AppWindow as WebIcon,
  Check as CheckIcon,
  Laptop as LaptopIcon,
  MonitorSmartphone as DevicesIcon,
  Monitor as ComputerDesktopIcon,
  Smartphone as PhoneIcon,
  Tablet as TabletIcon,
  X as XMarkIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { usePlayer, useRemotePlayback } from "../context/Player";
import { isElectron } from "../lib/platform";
import { PlayingBars } from "./TrackRowCells";
import { useDismiss } from "../lib/useDismiss";
import { useTransitionMount } from "../lib/useTransitionMount";

interface Props {
  open: boolean;
  anchor: HTMLElement | null;
  onClose: () => void;
}

export default function PlaybackDevicePopover({
  open,
  anchor,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useDismiss(ref, {
    onDismiss: onClose,
    enabled: open,
    capture: true,
    ignore: (target) => !!anchor?.contains(target),
  });

  const { mounted, visible } = useTransitionMount(open, 180);

  if (!mounted || !anchor) return null;

  const rect = anchor.getBoundingClientRect();
  const width = 300;
  const bottom = Math.max(12, window.innerHeight - rect.top + 8);
  const right = Math.max(12, window.innerWidth - rect.right);

  return createPortal(
    <div
      ref={ref}
      className="device-pop"
      data-closed={!visible || undefined}
      // Mounted only to play its exit: pointer-events alone would still
      // leave these controls tabbable and exposed to assistive tech.
      inert={visible ? undefined : ""}
      role="dialog"
      aria-label="Playback device"
      style={{ bottom, right, width }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="device-pop-head">
        <span className="device-pop-title">Play on</span>
        <DeviceConnectionStatus />
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="iconbtn device-pop-close"
          aria-label="Close device picker"
          onClick={onClose}
        >
          <XMarkIcon className="size-3.5" />
        </button>
      </div>

      <DeviceList onSelected={onClose} />
    </div>,
    document.body,
  );
}

/** The "Live" pill: whether this app is connected to your server. */
export function DeviceConnectionStatus() {
  const { connected } = useRemotePlayback();
  return (
    <span
      className="device-pop-status"
      data-online={connected || undefined}
      title={connected ? "Connected to your server" : "Reconnecting to your server"}
    >
      <span className="device-pop-status-dot" aria-hidden="true" />
      {connected ? "Live" : "Reconnecting"}
    </span>
  );
}

/**
 * This device and every other online one; pick one to play there. Shared by
 * the device popover and the mini player's device panel.
 */
export function DeviceList({ onSelected }: { onSelected?: () => void }) {
  const { isPlaying, current } = usePlayer();
  const { remoteDevices, targetDeviceId, lastCommandResult, selectTarget } =
    useRemotePlayback();
  const error =
    lastCommandResult && lastCommandResult.status !== "applied"
      ? lastCommandResult.error || `Command ${lastCommandResult.status}`
      : null;

  const localPlaying = !targetDeviceId && isPlaying && !!current;

  return (
    <>
      <div className="device-pop-body">
        <DeviceRow
          icon={<LocalIcon aria-hidden="true" />}
          name="This device"
          meta={
            localPlaying
              ? `Playing · ${current.title}`
              : targetDeviceId
                ? "Play here instead"
                : "Listening here"
          }
          active={!targetDeviceId}
          playing={localPlaying}
          onSelect={() => {
            selectTarget(null);
            onSelected?.();
          }}
        />

        <div className="device-pop-section">Other devices</div>
        {remoteDevices.length ? (
          remoteDevices.map((device) => {
            const Icon = iconFor(device.deviceName);
            const title = device.activity?.title;
            return (
              <DeviceRow
                key={device.deviceId}
                icon={<Icon aria-hidden="true" />}
                name={device.deviceName}
                meta={
                  title
                    ? `${device.activity?.is_playing ? "Playing" : "Paused"} · ${title}`
                    : "Online · Nothing playing"
                }
                online
                active={targetDeviceId === device.deviceId}
                playing={!!title && !!device.activity?.is_playing}
                onSelect={() => {
                  selectTarget(device.deviceId);
                  onSelected?.();
                }}
              />
            );
          })
        ) : (
          <div className="device-pop-empty">
            <span className="device-pop-empty-icon" aria-hidden="true">
              <DevicesIcon />
            </span>
            <span className="device-pop-empty-copy">
              <span className="device-pop-empty-title">No other devices online</span>
              <span className="device-pop-empty-hint">
                Open Lumen on your phone or another computer.
              </span>
            </span>
          </div>
        )}
      </div>

      {error && (
        <div className="device-pop-error" role="status">
          {error}
        </div>
      )}
    </>
  );
}

const LocalIcon = isElectron() ? LaptopIcon : WebIcon;

/** Icon for a device from the name its app reports (iPhone, iPad, Mobile, Desktop, Web). */
function iconFor(name: string) {
  if (/ipad|tablet/i.test(name)) return TabletIcon;
  if (/iphone|android|mobile|phone/i.test(name)) return PhoneIcon;
  if (/web|browser/i.test(name)) return WebIcon;
  return ComputerDesktopIcon;
}

function DeviceRow({
  icon,
  name,
  meta,
  active,
  playing,
  online,
  onSelect,
}: {
  icon: ReactNode;
  name: string;
  meta: string;
  active: boolean;
  playing: boolean;
  online?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={"device-pop-row" + (active ? " active" : "")}
      aria-pressed={active}
      onClick={onSelect}
    >
      <span className="device-pop-icon">
        {icon}
        {online && <span className="device-pop-online" aria-hidden="true" />}
      </span>
      <span className="device-pop-copy">
        <span className="device-pop-name">{name}</span>
        <span className="device-pop-meta">{meta}</span>
      </span>
      {playing ? (
        <PlayingBars className="device-pop-bars" />
      ) : (
        active && <CheckIcon className="device-pop-check" aria-hidden="true" />
      )}
    </button>
  );
}
