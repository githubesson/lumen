import { useMemo, useState, type FormEvent } from "react";
import {
  RefreshCw as ArrowPathIcon,
  RotateCcw as RetryIcon,
} from "lucide-react";
import {
  api,
  errorMessage,
  type MusicRoot,
  type TidalAutoDownloadStatus,
} from "../../api";
import { Button } from "../../components/Button";
import ErrorBanner from "../../components/ErrorBanner";
import { Field, TextInput } from "../../components/Field";
import { Select } from "../../components/Select";
import { useApiResource } from "../../lib/useApiResource";
import { AdminSectionTitle } from "./AdminSectionTitle";
import { formatDate } from "./format";

/**
 * Destination and progress for playlist TIDAL auto-download. Playlists opt in
 * from their own page; this card only picks where files land and shows the
 * queue.
 */
export function TidalAutoDownloadCard({ roots }: { roots: MusicRoot[] | null }) {
  const {
    data: status,
    error: loadError,
    loading,
    reload,
    update,
  } = useApiResource<TidalAutoDownloadStatus>(
    () => api.tidalAutoDownload(),
    "Failed to load TIDAL auto-download status.",
    { cacheKey: "admin:tidal-auto-download" },
  );
  // Unsaved edits over the server's values, rather than a copy of them: a
  // background refresh (the cached status, then the fresh one) can't discard
  // what the user has typed.
  const [edits, setEdits] = useState<{ rootId?: string; subdir?: string }>({});
  const rootId = edits.rootId ?? status?.root_id ?? "";
  const subdir = edits.subdir ?? status?.subdir ?? "";
  const setRootId = (value: string) => setEdits((e) => ({ ...e, rootId: value }));
  const setSubdir = (value: string) => setEdits((e) => ({ ...e, subdir: value }));
  const [busy, setBusy] = useState<"save" | "retry" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const error = actionError ?? loadError;

  const rootOptions = useMemo(
    () =>
      (roots ?? []).map((r) => ({
        value: r.id,
        label: r.primary ? `Primary - ${r.path}` : `${r.label || "Source"} - ${r.path}`,
        // Files under a disabled root can't be streamed.
        disabled: !r.exists || !r.enabled,
      })),
    [roots],
  );

  const dirty =
    !!status && (rootId !== (status.root_id ?? "") || subdir.trim() !== status.subdir);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("save");
    setActionError(null);
    try {
      // The response is what the server stored (it normalises the path), so
      // it becomes the status and the edits give way to it.
      const saved = await api.saveTidalAutoDownloadSettings({
        root_id: rootId || undefined,
        subdir: subdir.trim(),
      });
      update(() => saved);
      setEdits({});
      await reload();
    } catch (err) {
      setActionError(errorMessage(err, "Could not save the download folder."));
    } finally {
      setBusy(null);
    }
  };

  const retry = async () => {
    setBusy("retry");
    setActionError(null);
    try {
      await api.retryTidalAutoDownloads();
      await reload();
    } catch (err) {
      setActionError(errorMessage(err, "Could not retry failed downloads."));
    } finally {
      setBusy(null);
    }
  };

  const summary = status?.summary;
  const stats: Array<[string, number | undefined]> = [
    ["Playlists", summary?.playlists],
    ["Queued", summary?.queued],
    ["Failed", summary?.failed],
    ["Saved", summary?.saved],
  ];

  return (
    <section className="surface" style={{ padding: 16, display: "grid", gap: 14 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div>
          <AdminSectionTitle as="div">Playlist auto-download</AdminSectionTitle>
          <div style={{ fontSize: 14, color: "var(--muted-foreground)" }}>
            Turn it on from a playlist&apos;s page. Its TIDAL tracks are saved here
            and the playlist switches to the library copies.
          </div>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setActionError(null);
            reload();
          }}
          disabled={loading}
          leadingIcon={<ArrowPathIcon className="size-3.5" />}
        >
          Refresh
        </Button>
      </div>

      {error && <ErrorBanner message={error} />}
      {status && !status.ffmpeg && (
        <ErrorBanner message="ffmpeg is not installed on the server, so downloads are paused." />
      )}
      {status?.destination_error && (
        <ErrorBanner message={`Download folder unavailable: ${status.destination_error}`} />
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
          gap: 10,
        }}
      >
        {stats.map(([label, value]) => (
          <div key={label}>
            <div style={{ color: "var(--muted-foreground)", fontSize: 12 }}>{label}</div>
            <div className="mono" style={{ fontSize: 18 }}>
              {value ?? "-"}
            </div>
          </div>
        ))}
      </div>

      <form
        onSubmit={save}
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
          alignItems: "end",
        }}
      >
        <Field label="Music folder">
          <Select
            value={rootId}
            onChange={setRootId}
            options={rootOptions}
            placeholder="Select music folder"
            disabled={!rootOptions.length}
          />
        </Field>
        <Field label="Subfolder">
          <TextInput
            value={subdir}
            onChange={(e) => setSubdir(e.target.value)}
            placeholder="TIDAL"
          />
        </Field>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button
            size="sm"
            leadingIcon={<RetryIcon className="size-3.5" />}
            onClick={() => void retry()}
            disabled={busy !== null || !summary?.failed}
          >
            {busy === "retry" ? "Retrying..." : "Retry failed"}
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={busy !== null || !dirty}>
            {busy === "save" ? "Saving..." : "Save"}
          </Button>
        </div>
      </form>
      {status?.destination && (
        <div style={{ color: "var(--muted-foreground)", fontSize: 12, marginTop: -6 }}>
          Saves to <span className="font-mono">{status.destination}</span>/Artist/Album
        </div>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Track</th>
            <th>File</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {!status && (
            <tr>
              <td colSpan={4} className="mono" style={{ color: "var(--muted-foreground)" }}>
                Loading...
              </td>
            </tr>
          )}
          {status?.recent.length === 0 && (
            <tr>
              <td colSpan={4} style={{ color: "var(--muted-foreground)" }}>
                Nothing downloaded yet.
              </td>
            </tr>
          )}
          {status?.recent.map((row) => (
            <tr key={row.tidal_id}>
              <td>
                <span className={"badge" + (row.status === "failed" ? "" : " badge-accent")}>
                  {row.status === "existing" ? "in library" : row.status}
                </span>
                {row.error && (
                  <div style={{ color: "var(--destructive)", fontSize: 12, marginTop: 4 }}>
                    {row.error}
                    {row.next_attempt_at && ` · retry ${formatDate(row.next_attempt_at)}`}
                  </div>
                )}
              </td>
              <td>
                <div>{row.title || `TIDAL ${row.tidal_id}`}</div>
                {row.artist && (
                  <div style={{ color: "var(--muted-foreground)", fontSize: 12 }}>
                    {row.artist}
                  </div>
                )}
              </td>
              <td className="font-mono" style={{ wordBreak: "break-all" }}>
                {row.file_path || "-"}
              </td>
              <td className="mono">{formatDate(row.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
