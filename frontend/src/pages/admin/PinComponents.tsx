import { ReactNode } from "react";
import {
  ArrowPathIcon,
  CloudArrowDownIcon,
  PlayIcon,
  TrashIcon,
} from "@heroicons/react/16/solid";
import { isValidPinID } from "../../api";
import { Button } from "../../components/Button";
import { AdminSectionTitle } from "./AdminSectionTitle";
import { formatDate, formatInterval } from "./format";
import {
  downloadCounts,
  type DownloadLike,
  type PinLike,
  type PinManager,
} from "./usePinManager";

/** Per-pin status cell: enabled badge + (missing id | last error | counts). */
function PinStatusCell({
  pin,
  hasPinID,
  counts,
}: {
  pin: PinLike;
  hasPinID: boolean;
  counts: string | null;
}) {
  return (
    <div style={{ display: "grid", gap: 4, justifyItems: "start" }}>
      <span className={"badge" + (pin.enabled ? " badge-accent" : "")}>
        {pin.enabled ? "active" : "paused"}
      </span>
      {!hasPinID ? (
        <span style={{ color: "var(--danger-fg)", fontSize: 11 }}>
          missing pin id
        </span>
      ) : pin.last_error ? (
        <span style={{ color: "var(--danger-fg)", fontSize: 11 }}>
          {pin.last_error}
        </span>
      ) : counts ? (
        <span
          className="mono"
          style={{ color: "var(--fg-subtle)", fontSize: 10.5 }}
        >
          {counts}
        </span>
      ) : null}
    </div>
  );
}

/** Scan / Pause-Resume / History / Remove action cluster. */
function PinActions<Pin extends PinLike, Download extends DownloadLike>({
  pin,
  pinID,
  hasPinID,
  busy,
  manager,
}: {
  pin: Pin;
  pinID: string;
  hasPinID: boolean;
  busy: boolean;
  manager: PinManager<Pin, Download>;
}) {
  return (
    <div style={{ display: "inline-flex", gap: 6 }}>
      <Button
        size="sm"
        onClick={() => manager.scanPin(pin)}
        disabled={busy || !hasPinID || !pin.root_exists}
        leadingIcon={<PlayIcon className="size-3.5" />}
      >
        Scan
      </Button>
      <Button
        size="sm"
        onClick={() => manager.togglePin(pin)}
        disabled={busy || !hasPinID}
      >
        {pin.enabled ? "Pause" : "Resume"}
      </Button>
      <Button
        size="sm"
        onClick={() => manager.toggleHistory(pinID)}
        disabled={busy || !hasPinID}
        leadingIcon={<CloudArrowDownIcon className="size-3.5" />}
      >
        History
      </Button>
      <Button
        size="sm"
        variant="danger"
        onClick={() => manager.removePin(pin)}
        disabled={busy || !hasPinID}
        leadingIcon={<TrashIcon className="size-3.5" />}
      >
        Remove
      </Button>
    </div>
  );
}

/**
 * The shared pins table. Caller supplies the bespoke leading cells (name +
 * destination) for each row via `renderLead`; everything else (schedule, last
 * scan, status, actions) is identical between sources.
 */
export function PinTable<Pin extends PinLike, Download extends DownloadLike>({
  manager,
  emptyLabel,
  nameHeader,
  rowKey,
  renderLead,
}: {
  manager: PinManager<Pin, Download>;
  emptyLabel: string;
  nameHeader: string;
  rowKey: (pin: Pin) => string;
  renderLead: (pin: Pin) => ReactNode;
}) {
  const { pins, busyPins, downloadsByPin } = manager;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>{nameHeader}</th>
          <th>Destination</th>
          <th>Schedule</th>
          <th>Last scan</th>
          <th>Status</th>
          <th className="col-acts" />
        </tr>
      </thead>
      <tbody>
        {pins === null && (
          <tr>
            <td colSpan={6} className="mono" style={{ color: "var(--fg-subtle)" }}>
              Loading...
            </td>
          </tr>
        )}
        {pins?.length === 0 && (
          <tr>
            <td colSpan={6} style={{ color: "var(--fg-muted)" }}>
              {emptyLabel}
            </td>
          </tr>
        )}
        {pins?.map((pin) => {
          const pinID = pin.id?.trim() ?? "";
          const hasPinID = isValidPinID(pinID);
          const busy = hasPinID && busyPins.has(pinID);
          const counts = hasPinID
            ? downloadCounts(downloadsByPin[pinID])
            : null;
          return (
            <tr key={rowKey(pin)}>
              {renderLead(pin)}
              <td className="mono">{formatInterval(pin.scan_interval_seconds)}</td>
              <td className="mono">{formatDate(pin.last_scan_at)}</td>
              <td>
                <PinStatusCell pin={pin} hasPinID={hasPinID} counts={counts} />
              </td>
              <td className="col-acts" style={{ minWidth: 340 }}>
                <PinActions
                  pin={pin}
                  pinID={pinID}
                  hasPinID={hasPinID}
                  busy={busy}
                  manager={manager}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Expandable download-history table shared by both sources. The only structural
 * difference is which field holds the upstream reference (`source_url` for
 * ArtistGrid, `source_path` for Filen), selected via `sourceField`.
 */
export function DownloadHistoryTable<Download extends DownloadLike & {
  error?: string;
  file_path?: string;
  updated_at: string;
  source_url?: string;
  source_path?: string;
}>({
  title,
  rows,
  sourceField,
  onRefresh,
}: {
  title: ReactNode;
  rows: Download[] | undefined;
  sourceField: "source_url" | "source_path";
  onRefresh: () => void;
}) {
  return (
    <section className="surface" style={{ padding: 16 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "center",
          marginBottom: 10,
        }}
      >
        <div>
          <AdminSectionTitle as="div">Recent downloads</AdminSectionTitle>
          <div style={{ fontSize: 12.5, color: "var(--fg-muted)" }}>{title}</div>
        </div>
        <Button
          size="sm"
          onClick={onRefresh}
          leadingIcon={<ArrowPathIcon className="size-3.5" />}
        >
          Refresh
        </Button>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Status</th>
            <th>File</th>
            <th>Source</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {!rows && (
            <tr>
              <td colSpan={4} className="mono" style={{ color: "var(--fg-subtle)" }}>
                Loading...
              </td>
            </tr>
          )}
          {rows?.length === 0 && (
            <tr>
              <td colSpan={4} style={{ color: "var(--fg-muted)" }}>
                No download records yet.
              </td>
            </tr>
          )}
          {rows?.map((row) => (
            <tr key={row.id}>
              <td>
                <span
                  className={
                    "badge" +
                    (row.status === "downloaded" || row.status === "existing"
                      ? " badge-accent"
                      : "")
                  }
                >
                  {row.status}
                </span>
                {row.error && (
                  <div
                    style={{
                      color: "var(--danger-fg)",
                      fontSize: 11,
                      marginTop: 4,
                    }}
                  >
                    {row.error}
                  </div>
                )}
              </td>
              <td className="mono" style={{ wordBreak: "break-all" }}>
                {row.file_path || "-"}
              </td>
              <td className="mono" style={{ wordBreak: "break-all" }}>
                {row[sourceField]}
              </td>
              <td className="mono">{formatDate(row.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
