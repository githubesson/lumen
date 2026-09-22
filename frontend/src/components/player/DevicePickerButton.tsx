import { useState } from "react";
import { Monitor as ComputerDesktopIcon } from "lucide-react";
import { useRemotePlayback } from "../../context/Player";
import PlaybackDevicePopover from "../PlaybackDevicePopover";

export default function DevicePickerButton({
  miniPlayerMode,
}: {
  miniPlayerMode: boolean;
}) {
  const { targetDevice, commandPending, lastCommandResult } =
    useRemotePlayback();
  // The popover anchor is held in state, not a ref: the popover reads the
  // element during render, and a ref's `.current` is not readable during
  // render under concurrent React (nor would it re-render the popover when it
  // lands).
  const [deviceBtn, setDeviceBtn] = useState<HTMLButtonElement | null>(null);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const isRemoteMode = !!targetDevice;
  const commandError =
    lastCommandResult && lastCommandResult.status !== "applied"
      ? lastCommandResult.error || `Command ${lastCommandResult.status}`
      : null;

  return (
    <>
      <button
        ref={setDeviceBtn}
        type="button"
        className={
          "t-btn device-picker-btn" +
          (isRemoteMode || deviceOpen ? " active" : "") +
          (commandPending ? " pending" : "") +
          (commandError ? " error" : "")
        }
        title={
          commandError
            ? commandError
            : targetDevice
              ? `Controlling ${targetDevice.deviceName}`
              : "Choose playback device"
        }
        aria-label={
          targetDevice
            ? `Playback device: ${targetDevice.deviceName}`
            : "Choose playback device"
        }
        aria-expanded={deviceOpen}
        onClick={() => setDeviceOpen((open) => !open)}
      >
        <ComputerDesktopIcon className="size-3.5" />
        {isRemoteMode && (
          <span className="device-picker-live" aria-hidden="true" />
        )}
      </button>
      <PlaybackDevicePopover
        open={deviceOpen}
        anchor={deviceBtn}
        miniPlayerMode={miniPlayerMode}
        onClose={() => setDeviceOpen(false)}
      />
    </>
  );
}
