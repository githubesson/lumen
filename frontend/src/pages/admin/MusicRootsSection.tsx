import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  FolderPlusIcon,
  TrashIcon,
} from "@heroicons/react/16/solid";
import {
  api,
  errorMessage,
  type MusicRoot,
  type RescanStatus,
} from "../../api";
import { Button } from "../../components/Button";
import ErrorBanner from "../../components/ErrorBanner";
import { Field, TextInput } from "../../components/Field";
import { libraryChanged } from "../../lib/events";
import { AdminSectionTitle } from "./AdminSectionTitle";

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div
        className="mono"
        style={{ fontSize: 10, color: "var(--fg-subtle)", marginBottom: 2 }}
      >
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, color: "var(--fg)" }}>
        {value}
      </div>
    </div>
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

  const loadStatus = useCallback(async () => {
    try {
      setRescan(await api.rescanStatus());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
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
      void loadStatus();
    }, 1000);
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [rescan?.running, loadStatus]);

  useEffect(() => {
    if (rescan && rescan.running === false && (rescan.processed ?? 0) > 0) {
      libraryChanged.emit();
    }
  }, [rescan?.running, rescan?.processed]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    onError("");
    setAdding(true);
    try {
      await api.addMusicRoot({ path: path.trim(), label: label.trim() });
      setPath("");
      setLabel("");
      await reloadRoots();
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
    } catch (err) {
      onError(errorMessage(err, "Failed to update root."));
    }
  };

  const remove = async (r: MusicRoot) => {
    if (
      !window.confirm(
        `Stop watching ${r.path}?\n\nThe watcher will no longer pick up changes in this folder.`,
      )
    )
      return;
    const purge = window.confirm(
      `Also remove every track from "${r.path}" from your library?\n\nOK — delete those tracks from the library (you can re-add them by scanning the folder again).\nCancel — keep the existing DB entries even though the folder is gone.`,
    );
    onError("");
    try {
      const res = await api.deleteMusicRoot(r.id, { purge });
      await reloadRoots();
      if (purge && res?.deleted_tracks) {
        libraryChanged.emit();
      }
    } catch (err) {
      onError(errorMessage(err, "Failed to remove root."));
    }
  };

  const startRescan = async () => {
    onError("");
    try {
      await api.startRescan();
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
          color: "var(--fg-muted)",
          fontSize: 13,
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
            <Field
              label="Path"
              hint="Absolute path on the server — e.g. /mnt/external/flac"
            >
              <TextInput
                name="path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/mnt/library/extras"
                required
              />
            </Field>
          </div>
          <div style={{ width: 240 }}>
            <Field label="Label" hint="Optional">
              <TextInput
                name="label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="External drive"
              />
            </Field>
          </div>
          <Button
            type="submit"
            variant="primary"
            leadingIcon={<FolderPlusIcon className="size-4" />}
            disabled={adding || !path.trim()}
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
        <table className="table">
          <thead>
            <tr>
              <th>Path</th>
              <th>Label</th>
              <th>Status</th>
              <th className="col-acts" />
            </tr>
          </thead>
          <tbody>
            {roots === null && (
              <tr>
                <td colSpan={4} className="mono" style={{ color: "var(--fg-subtle)" }}>
                  Loading…
                </td>
              </tr>
            )}
            {roots?.length === 0 && (
              <tr>
                <td colSpan={4} style={{ color: "var(--fg-muted)" }}>
                  No folders yet. Add one above.
                </td>
              </tr>
            )}
            {roots?.map((r) => (
              <tr key={r.id || "primary"}>
                <td className="mono" style={{ color: "var(--fg)", wordBreak: "break-all" }}>
                  {r.path}
                  {!r.exists && (
                    <span
                      title="This directory does not exist on the server"
                      style={{
                        marginLeft: 8,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        color: "var(--warning-fg)",
                        fontSize: 11,
                      }}
                    >
                      <ExclamationTriangleIcon className="size-3" aria-hidden="true" />
                      missing
                    </span>
                  )}
                </td>
                <td style={{ color: "var(--fg-muted)" }}>
                  {r.primary ? <em>Primary (MUSIC_PATH)</em> : r.label || "—"}
                </td>
                <td>
                  <span className={"badge" + (r.enabled ? " badge-accent" : "")}>
                    {r.primary ? "primary" : r.enabled ? "active" : "paused"}
                  </span>
                </td>
                <td className="col-acts">
                  {!r.primary && (
                    <div style={{ display: "inline-flex", gap: 6 }}>
                      <Button size="sm" onClick={() => toggle(r)}>
                        {r.enabled ? "Pause" : "Resume"}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => remove(r)}
                        leadingIcon={<TrashIcon className="size-3.5" />}
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {rescan && !rescan.running && (rescan.processed ?? 0) > 0 && (
        <section
          className="surface"
          style={{ padding: 16, fontSize: 12.5, color: "var(--fg-muted)" }}
        >
          <AdminSectionTitle as="div" style={{ marginBottom: 8 }}>
            Last scan
          </AdminSectionTitle>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
            <Stat label="Processed" value={rescan.processed ?? 0} />
            <Stat label="Inserted" value={rescan.inserted ?? 0} />
            <Stat label="Dedup" value={rescan.dedup ?? 0} />
            <Stat label="Errored" value={rescan.errored ?? 0} />
            <Stat label="Pruned" value={rescan.pruned ?? 0} />
          </div>
        </section>
      )}
    </>
  );
}
