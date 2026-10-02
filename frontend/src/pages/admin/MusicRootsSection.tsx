import {
  addMusicRootInput,
  canManageMusicRoot,
  musicRootKey,
  musicRootName,
  rescanChangedLibrary,
  rootRemovalChangedLibrary,
} from "@music-library/core/admin/music-roots";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  RefreshCw as ArrowPathIcon,
  TriangleAlert as ExclamationTriangleIcon,
  FolderPlus as FolderPlusIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  Trash2 as TrashIcon,
} from "lucide-react";
import {
  api,
  errorMessage,
  type IngestErrors,
  type MusicRoot,
  type MusicRootUsage,
  type RescanStatus,
} from "../../api";
import { Button } from "../../components/Button";
import ErrorBanner from "../../components/ErrorBanner";
import { Field, TextInput } from "../../components/Field";
import { libraryChanged } from "../../lib/events";
import { fmtBytes } from "../../lib/format";
import { useApiResource } from "../../lib/useApiResource";
import { AdminSectionTitle } from "./AdminSectionTitle";
import { INGEST_ERRORS_ID, IngestErrorsList } from "./IngestErrorsList";
import { RemoveFolderDialog } from "./RemoveFolderDialog";

function Stat({
  label,
  value,
  onClick,
  title,
}: {
  label: string;
  value: number;
  /** Makes the number a link to more detail. */
  onClick?: () => void;
  title?: string;
}) {
  return (
    <div>
      <div
        className="mono"
        style={{ fontSize: 12, color: "var(--muted-foreground)", marginBottom: 2 }}
      >
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, color: "var(--foreground)" }}>
        {onClick ? (
          <button type="button" className="stat-link" onClick={onClick} title={title}>
            {value}
          </button>
        ) : (
          value
        )}
      </div>
    </div>
  );
}


/** A bar where a number will be, while the server walks the folders. */
function Measuring() {
  return (
    <span
      className="skeleton-text"
      style={{ width: 48 }}
      aria-label="Measuring"
      role="img"
    />
  );
}

/**
 * Music roots management: add/pause/remove watched folders and drive the
 * full-library rescan with live progress.
 */
export function MusicRootsSection({
  roots,
  reloadRoots,
  error,
  onError,
}: {
  roots: MusicRoot[] | null;
  reloadRoots: () => Promise<void>;
  error: string | null;
  onError: (message: string) => void;
}) {
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [rescan, setRescan] = useState<RescanStatus | null>(null);
  const pollRef = useRef<number | null>(null);

  // Sizes come from a walk of the folders on disk, so they load on their own
  // and the table shows up without waiting for them. The server caches the
  // walk for a few minutes; a finished rescan asks it to walk again.
  const refreshUsageRef = useRef(false);
  const {
    data: usage,
    error: usageError,
    reload: reloadUsage,
  } = useApiResource<MusicRootUsage>(
    (signal) => {
      const refresh = refreshUsageRef.current;
      refreshUsageRef.current = false;
      return api.musicRootUsage({ refresh }, { signal });
    },
    "Couldn't measure the folders.",
    { cacheKey: "admin:roots-usage" },
  );
  const usageByPath = new Map(usage?.roots.map((u) => [u.path, u]));

  const {
    data: ingestErrors,
    error: ingestErrorsError,
    reload: reloadErrors,
  } = useApiResource<IngestErrors>(
    (signal) => api.listIngestErrors({ signal }),
    "the request failed",
    { cacheKey: "admin:ingest-errors" },
  );
  const [showErrors, setShowErrors] = useState(false);
  const openErrors = () => {
    setShowErrors(true);
    // After the list is un-hidden, so there's something to scroll to.
    requestAnimationFrame(() => {
      document.getElementById(INGEST_ERRORS_ID)?.scrollIntoView({ block: "nearest" });
    });
  };

  // Stays set through the dialog's exit fade, so its text doesn't blank out.
  const [removeTarget, setRemoveTarget] = useState<MusicRoot | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setRescan(await api.rescanStatus());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    // Initial load synchronizes this section with the rescan API.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!rescan?.running) {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = window.setInterval(() => {
      if (!document.hidden) void loadStatus();
    }, 1000);
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [rescan?.running, loadStatus]);

  // Reacts to a scan seen running and then finishing, not to the idle status
  // every load reports, which still carries the last scan's counts.
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (rescan?.running) {
      wasRunningRef.current = true;
    } else if (rescan && wasRunningRef.current) {
      wasRunningRef.current = false;
      if (rescanChangedLibrary(rescan)) libraryChanged.emit();
      refreshUsageRef.current = true;
      void reloadUsage();
      void reloadErrors();
    }
  }, [rescan, reloadUsage, reloadErrors]);

  const addInput = addMusicRootInput(path, label);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!addInput) return;
    onError("");
    setAdding(true);
    try {
      await api.addMusicRoot(addInput);
      setPath("");
      setLabel("");
      await reloadRoots();
      void reloadUsage();
      // Import errors are listed for the folders being scanned, which just changed.
      void reloadErrors();
    } catch (err) {
      onError(errorMessage(err, "Failed to add root."));
    } finally {
      setAdding(false);
    }
  };

  const toggle = async (r: MusicRoot) => {
    onError("");
    try {
      await api.setMusicRootEnabled(r.id, !r.enabled);
      await reloadRoots();
      void reloadErrors();
    } catch (err) {
      onError(errorMessage(err, "Failed to update root."));
    }
  };

  const remove = (r: MusicRoot) => {
    onError("");
    setRemoveTarget(r);
    setRemoveOpen(true);
  };

  const onRemoved = async (result: { purged: boolean; deletedTracks: number }) => {
    setRemoveOpen(false);
    await reloadRoots();
    void reloadUsage();
    void reloadErrors();
    if (rootRemovalChangedLibrary(result)) libraryChanged.emit();
  };

  const startRescan = async () => {
    onError("");
    try {
      await api.startRescan();
      // Running until a status read says otherwise. That starts the polling
      // even if the first read fails, and counts a small scan that finishes
      // before any read sees it, so the sizes and errors still refresh.
      setRescan({ running: true });
      await loadStatus();
    } catch (err) {
      onError(errorMessage(err, "Failed to start rescan."));
    }
  };

  const runningProgress = rescan?.running
    ? `${rescan.processed ?? 0} / ${rescan.total ?? "?"}`
    : null;

  return (
    <>
      <p
        style={{
          color: "var(--muted-foreground)",
          fontSize: 14,
          margin: 0,
          maxWidth: "70ch",
        }}
      >
        The primary music directory is set via <code>MUSIC_PATH</code> and
        receives uploads. Add extra folders here to have them scanned and
        watched live alongside the primary root.
      </p>

      <section
        aria-labelledby="add-root"
        className="surface"
        style={{ padding: 20 }}
      >
        <AdminSectionTitle id="add-root" style={{ margin: "0 0 14px" }}>
          Add folder
        </AdminSectionTitle>
        <form
          onSubmit={add}
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            alignItems: "end",
          }}
        >
          <div style={{ flex: "1 1 320px", minWidth: 240 }}>
            <Field label="Path">
              <TextInput
                name="path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="Absolute path on the server, e.g. /mnt/external/flac"
                required
              />
            </Field>
          </div>
          <div style={{ width: 240 }}>
            <Field label="Label">
              <TextInput
                name="label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Optional"
              />
            </Field>
          </div>
          <Button
            type="submit"
            variant="primary"
            leadingIcon={<FolderPlusIcon className="size-4" />}
            disabled={adding || !addInput}
          >
            {adding ? "Adding…" : "Add"}
          </Button>
        </form>
      </section>

      {error && <ErrorBanner message={error} />}

      <section>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            margin: "0 0 12px",
          }}
        >
          <AdminSectionTitle>Configured folders</AdminSectionTitle>
          <Button
            size="sm"
            onClick={startRescan}
            disabled={rescan?.running}
            leadingIcon={<ArrowPathIcon className="size-3.5" />}
          >
            {rescan?.running
              ? `Scanning ${runningProgress}`
              : "Rescan all folders"}
          </Button>
        </div>
        <table className="table table-static">
          <thead>
            <tr>
              <th>Folder</th>
              <th className="col-num">Files</th>
              <th className="col-num">Size</th>
              <th className="col-acts" />
            </tr>
          </thead>
          <tbody>
            {roots === null && (
              <tr>
                <td colSpan={4} className="mono" style={{ color: "var(--muted-foreground)" }}>
                  Loading…
                </td>
              </tr>
            )}
            {roots?.length === 0 && (
              <tr>
                <td colSpan={4} style={{ color: "var(--muted-foreground)" }}>
                  No folders yet. Add one above.
                </td>
              </tr>
            )}
            {roots?.map((r) => {
              const u = usageByPath.get(r.path);
              const measuring = !u && !usageError && r.exists;
              return (
                <tr key={musicRootKey(r)}>
                  <td>
                    <div className="row-name">
                      <span className="track-title">
                        {musicRootName(r)}
                      </span>
                      {!r.primary && !r.enabled && (
                        <span className="badge">paused</span>
                      )}
                      {!r.exists && (
                        <span
                          className="row-warning"
                          title="This directory does not exist on the server"
                        >
                          <ExclamationTriangleIcon className="size-3" aria-hidden="true" />
                          missing
                        </span>
                      )}
                    </div>
                    <div className="track-sub font-mono" style={{ wordBreak: "break-all" }}>
                      {r.path}
                    </div>
                  </td>
                  <td className="col-num">
                    {measuring ? <Measuring /> : u && r.exists ? u.files.toLocaleString() : "—"}
                  </td>
                  <td className="col-num">
                    {measuring ? <Measuring /> : u && r.exists ? fmtBytes(u.bytes) : "—"}
                  </td>
                  <td className="col-acts">
                    {canManageMusicRoot(r) && (
                      <div className="admin-actions">
                        <button
                          type="button"
                          className="iconbtn"
                          onClick={() => void toggle(r)}
                          aria-label={`${r.enabled ? "Pause" : "Resume"} ${r.path}`}
                          title={r.enabled ? "Pause watching" : "Resume watching"}
                        >
                          {r.enabled ? (
                            <PauseIcon className="size-4" aria-hidden="true" />
                          ) : (
                            <PlayIcon className="size-4" aria-hidden="true" />
                          )}
                        </button>
                        <button
                          type="button"
                          className="iconbtn iconbtn-danger"
                          onClick={() => remove(r)}
                          aria-label={`Remove ${r.path}`}
                          title="Remove folder"
                        >
                          <TrashIcon className="size-4" aria-hidden="true" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {usageError && (
          <p style={{ fontSize: 12, color: "var(--muted-foreground)", margin: "8px 0 0" }}>
            {usageError}{" "}
            <button type="button" className="stat-link" onClick={() => void reloadUsage()}>
              Try again
            </button>
          </p>
        )}
        {/* Without this a failed load looks the same as having no failures. */}
        {ingestErrorsError && (
          <p style={{ fontSize: 12, color: "var(--muted-foreground)", margin: "8px 0 0" }}>
            Couldn&apos;t check for files that failed to import: {ingestErrorsError}{" "}
            <button type="button" className="stat-link" onClick={() => void reloadErrors()}>
              Try again
            </button>
          </p>
        )}
        {(ingestErrors?.total ?? 0) > 0 && (
          <div style={{ marginTop: 12 }}>
            <IngestErrorsList
              data={ingestErrors}
              open={showErrors}
              onOpenChange={setShowErrors}
            />
          </div>
        )}
      </section>

      {rescan && !rescan.running && (rescan.processed ?? 0) > 0 && (
        <section
          className="surface"
          style={{ padding: 16, fontSize: 14, color: "var(--muted-foreground)" }}
        >
          <AdminSectionTitle as="div" style={{ marginBottom: 8 }}>
            Last scan
          </AdminSectionTitle>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
            <Stat label="Processed" value={rescan.processed ?? 0} />
            <Stat label="Inserted" value={rescan.inserted ?? 0} />
            <Stat label="Dedup" value={rescan.dedup ?? 0} />
            <Stat
              label="Errored"
              value={rescan.errored ?? 0}
              onClick={
                (rescan.errored ?? 0) > 0 && (ingestErrors?.total ?? 0) > 0
                  ? openErrors
                  : undefined
              }
              title="Show the files that failed"
            />
            <Stat label="Pruned" value={rescan.pruned ?? 0} />
          </div>
        </section>
      )}

      <RemoveFolderDialog
        key={removeTarget?.id}
        root={removeTarget}
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        onRemoved={onRemoved}
      />
    </>
  );
}
