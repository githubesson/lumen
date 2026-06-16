import { createPortal } from "react-dom";
import {
  ArrowDownTrayIcon,
  CheckIcon,
  XMarkIcon,
} from "@heroicons/react/16/solid";
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
  const host =
    hostId && typeof document !== "undefined"
      ? document.getElementById(hostId)
      : null;

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
        <button type="button" className="btn" onClick={onToggleMode}>
          <CheckIcon className="size-3.5" />
          Select
        </button>
      )}
    </div>
  );

  return host ? createPortal(toolbar, host) : toolbar;
}
