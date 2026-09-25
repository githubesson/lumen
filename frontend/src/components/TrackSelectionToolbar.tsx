import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Download as ArrowDownTrayIcon,
  Check as CheckIcon,
  X as XMarkIcon,
} from "lucide-react";
import clsx from "clsx";

interface TrackSelectionToolbarProps {
  selectionMode: boolean;
  selectedCount: number;
  totalCount: number;
  exportNotice: string | null;
  allSelected: boolean;
  someSelected: boolean;
  exporting?: boolean;
  exportDisabled?: boolean;
  exportDisabledReason?: string;
  onToggleMode: () => void;
  onSelectAll: () => void;
  onExport: () => void;
  onClear: () => void;
  /** When provided, the toolbar is rendered into the host element via portal. */
  hostId?: string;
  className?: string;
}

/**
 * Selection chrome for track tables. Shows either a "Select" button or the
 * active selection actions (select all / export / clear). Handles its own
 * portal attachment when a host element id is supplied.
 */
export default function TrackSelectionToolbar({
  selectionMode,
  selectedCount,
  totalCount,
  exportNotice,
  allSelected,
  someSelected,
  exporting = false,
  exportDisabled = false,
  exportDisabledReason,
  onToggleMode,
  onSelectAll,
  onExport,
  onClear,
  hostId,
  className,
}: TrackSelectionToolbarProps) {
  const host = usePortalHost(hostId);
  if (host === undefined) return null;

  const toolbar = (
    <div
      className={clsx(
        "track-selectbar",
        host ? "track-selectbar-attached" : undefined,
        className,
      )}
      data-selecting={selectionMode}
    >
      <div className="track-selectbar-status" aria-live="polite">
        {selectionMode
          ? `${selectedCount} selected`
          : `${totalCount} track${totalCount === 1 ? "" : "s"}`}
        {exportNotice && <span>{exportNotice}</span>}
      </div>
      {selectionMode ? (
        <>
          <button type="button" className="btn" onClick={onSelectAll}>
            {allSelected ? "Deselect all" : "Select all"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={onExport}
            disabled={!someSelected || exportDisabled || exporting}
            title={exportDisabled && someSelected ? exportDisabledReason : undefined}
          >
            <ArrowDownTrayIcon className="size-3.5" />
            {exporting ? "Exporting..." : "Export files"}
          </button>
          <button
            type="button"
            className="iconbtn track-selectbar-close"
            aria-label="Clear selection"
            onClick={() => {
              onClear();
            }}
          >
            <XMarkIcon className="size-4" />
          </button>
        </>
      ) : (
        <SelectButton onClick={onToggleMode} />
      )}
    </div>
  );

  return host ? createPortal(toolbar, host) : toolbar;
}

/**
 * A disabled "Select" in the toolbar host while the list it belongs to is
 * still loading, so the button is there from the first frame instead of
 * popping into the toolbar once the tracks arrive.
 */
export function TrackSelectionToolbarPlaceholder({ hostId }: { hostId: string }) {
  const host = usePortalHost(hostId);
  if (!host) return null;
  return createPortal(
    <div className="track-selectbar track-selectbar-attached" data-selecting={false}>
      <SelectButton disabled />
    </div>,
    host,
  );
}

function SelectButton({ onClick, disabled }: { onClick?: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="btn" onClick={onClick} disabled={disabled}>
      <CheckIcon className="size-3.5" />
      Select
    </button>
  );
}

/**
 * The host element, looked up after commit. The host usually mounts in the
 * same commit as the list (switching grid to list, a playlist loading), so a
 * lookup during render misses it and the bar would paint inline above the
 * table for a frame. `undefined` means not looked up yet (render nothing);
 * `null` means there's no host (render inline).
 */
function usePortalHost(hostId: string | undefined) {
  const [host, setHost] = useState<HTMLElement | null | undefined>(
    hostId ? undefined : null,
  );
  // No deps: the host can mount or remount without this component re-keying
  // (a playlist growing past one track). The bail-out below ends the loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const next = hostId ? document.getElementById(hostId) : null;
    // Syncing from the DOM, which only exists after commit.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHost((prev) => (prev === next ? prev : next));
  });
  return host;
}
