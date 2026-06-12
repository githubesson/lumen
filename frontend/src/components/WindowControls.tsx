import {
  MinusIcon,
  Square2StackIcon,
  XMarkIcon,
} from "@heroicons/react/16/solid";

export default function WindowControls({ className = "" }: { className?: string }) {
  if (!window.electron?.isElectron) return null;

  return (
    <div
      className={`window-controls${className ? ` ${className}` : ""}`}
      aria-label="Window controls"
    >
      <button
        type="button"
        className="window-control"
        title="Minimize"
        aria-label="Minimize"
        onClick={() => void window.electron?.minimizeWindow()}
      >
        <MinusIcon className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="window-control"
        title="Maximize"
        aria-label="Maximize"
        onClick={() => void window.electron?.toggleMaximizeWindow()}
      >
        <Square2StackIcon className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="window-control close"
        title="Close"
        aria-label="Close"
        onClick={() => void window.electron?.closeWindow()}
      >
        <XMarkIcon className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
