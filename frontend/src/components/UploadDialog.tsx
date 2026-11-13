import { useEffect, useRef, useState } from "react";
import { Upload as ArrowUpTrayIcon, Check as CheckIcon, FolderOpen as FolderIcon, Image as PhotoIcon } from "lucide-react";
import { api, type UploadResult } from "../api";
import { Button } from "./Button";
import DialogFooter from "./DialogFooter";
import ErrorBanner from "./ErrorBanner";
import Fieldset from "./Fieldset";
import { Field, FieldRow, TextInput } from "./Field";
import Switch from "./Switch";
import { applyUploadEdits, type UploadEdits } from "../lib/uploadEdits";
import RadioCardOption from "./RadioCardOption";
import { DialogShell } from "./DialogShell";
import { displayPath, filesFromDrop, mergeFiles } from "../lib/droppedFiles";
import { libraryChanged } from "../lib/events";
import { pluralize } from "../lib/format";
import { useTransitionMount } from "../lib/useTransitionMount";
import {
  defaultUploadScope,
  isUploadableFile,
  planUploadBatches,
  sendUploadBatch,
  tooLargeUploadResult,
  UPLOAD_EXTENSIONS,
  uploadAddedAny,
  uploadResultDetail,
  uploadResultStatus,
  uploadErrorMessage,
  uploadScope,
  type UploadScope,
} from "@music-library/core/upload";

// The file picker offers only what the server ingests.
const ACCEPT = UPLOAD_EXTENSIONS.map((ext) => `.${ext}`).join(",");

interface Props {
  open: boolean;
  isAdmin: boolean;
  onClose: () => void;
  onComplete?: () => void;
}

/**
 * Drag-and-drop upload dialog. The full-viewport drop zone wraps DialogShell
 * so the modal itself still benefits from the shared scrim / header / footer
 * / transition / Escape-to-close behavior.
 */
export default function UploadDialog({ open, isAdmin, onClose, onComplete }: Props) {
  const { mounted } = useTransitionMount(open, 200);
  const [scope, setScope] = useState<UploadScope>(() => defaultUploadScope(isAdmin));
  const [files, setFiles] = useState<File[]>([]);
  // Picked or dropped files the server wouldn't ingest, left out up front.
  const [leftOut, setLeftOut] = useState<string[]>([]);
  const [results, setResults] = useState<UploadResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  // Files sent so far, for "Uploading 120 of 450".
  const [progress, setProgress] = useState(0);
  // Cancelling stops the request in flight (the server undoes what it had
  // added) and removes what earlier requests added.
  const abortRef = useRef<AbortController | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelNote, setCancelNote] = useState<string | null>(null);
  const cancel = () => {
    if (!busy) return onClose();
    setCancelling(true);
    abortRef.current?.abort();
  };
  // Escape, the scrim and the close button only close: during an upload they
  // do nothing, since stopping one also removes what it already added. That
  // takes the footer's Cancel upload.
  const dismiss = () => {
    if (!busy) onClose();
  };
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const coverRef = useRef<HTMLInputElement>(null);
  // Details typed in before uploading, applied to the tracks as they're added.
  const [editing, setEditing] = useState(false);
  const [perFile, setPerFile] = useState<Map<File, { title: string; artists: string }>>(new Map());
  const [album, setAlbum] = useState("");
  const [albumArtist, setAlbumArtist] = useState("");
  const [cover, setCover] = useState<File | null>(null);
  const setFileField = (file: File, key: "title" | "artists", value: string) =>
    setPerFile((prev) => {
      const next = new Map(prev);
      next.set(file, { title: "", artists: "", ...prev.get(file), [key]: value });
      return next;
    });

  // Whether results are up, as of the last pick (state would be stale in a
  // walk that finishes after another one).
  const resultsShownRef = useRef(false);
  useEffect(() => {
    resultsShownRef.current = results !== null;
  }, [results]);

  // Picks and drops add to the selection, so files and folders can be mixed.
  const accept = (list: FileList | File[] | null) => {
    // An upload reads the selection once, as it starts: files added during
    // it would show as selected but never go.
    if (busy || !list || list.length === 0) return;
    const all = Array.from(list);
    // Against the selection as it is now: two folder walks can finish in
    // either order, and each must add to what the other added. Picking after
    // an upload's results starts a new selection, once: the first walk to
    // finish clears it, the next adds to that.
    const fresh = resultsShownRef.current;
    resultsShownRef.current = false;
    setFiles((prev) => mergeFiles(fresh ? [] : prev, all.filter((f) => isUploadableFile(f.name))));
    setLeftOut((prev) => [...(fresh ? [] : prev), ...all.filter((f) => !isUploadableFile(f.name)).map(displayPath)]);
    setResults(null);
    setError(null);
  };

  const clear = () => {
    setFiles([]);
    setLeftOut([]);
  };

  const submit = async () => {
    if (files.length === 0) return;
    if (editing && albumArtist.trim() && !album.trim()) {
      // The album artist belongs to an album; on its own it would be dropped.
      setError("Add an album title to set its album artist.");
      return;
    }
    setBusy(true);
    setError(null);
    setCancelNote(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    // One request over the server's cap fails whole, so a big selection goes
    // up in batches, one after another. A file too big to send at all is
    // reported with the rest rather than sent.
    const { batches, tooLarge } = planUploadBatches(files, (f) => f.size);
    const uploaded: UploadResult[] = [];
    let sent = 0;
    const scopeSent = uploadScope(isAdmin, scope);
    const edits: UploadEdits | null = editing
      ? { perFile: files.map((f) => perFile.get(f) ?? { title: "", artists: "" }), album, albumArtist, cover }
      : null;
    setProgress(0);
    // Across batches, so an album split between two gets its cover once.
    const coveredAlbums = new Set<string>();
    try {
      for (const batch of batches) {
        if (ctrl.signal.aborted) break;
        // Only admins may upload to the shared library; the choice is hidden
        // from everyone else.
        const results = await sendUploadBatch(() => api.uploadMusic(batch, scopeSent, { signal: ctrl.signal }), ctrl.signal);
        // In the list at once, so a cancel during the edits below still
        // takes these tracks back; the edited results replace them after.
        const at = uploaded.length;
        uploaded.push(...results);
        if (edits) {
          const edited = await applyUploadEdits(results, batch.map((f) => files.indexOf(f)), edits, scopeSent, {
            signal: ctrl.signal,
            coveredAlbums,
          });
          uploaded.splice(at, results.length, ...edited);
        }
        sent += batch.length;
        setProgress(sent);
      }
      if (ctrl.signal.aborted) throw new DOMException("cancelled", "AbortError");
      setResults([...uploaded, ...tooLarge.map((f) => tooLargeUploadResult(f.name))]);
      onComplete?.();
    } catch (err) {
      if (ctrl.signal.aborted) {
        // Take back what finished before the cancel; nothing half-done stays.
        // A promoted track was someone's personal upload before this one
        // shared it: not new, so it stays. A server too old to say leaves a
        // shared upload's tracks in doubt, so those stay too (counted below
        // as left for the user to delete).
        const addedHere = uploaded.filter((r) => r.inserted && !r.promoted && r.track_id);
        const removable = addedHere.filter((r) => scopeSent !== "global" || r.promoted === false);
        let removed = 0;
        for (const r of removable) {
          if (!r.track_id) continue;
          try {
            await (scopeSent === "global" ? api.deleteGlobalTrack(r.track_id) : api.deleteTrack(r.track_id));
            removed++;
          } catch {
            // Reported in the count below.
          }
        }
        const added = addedHere.length;
        setCancelNote(
          added === 0
            ? "Upload cancelled. Nothing was added."
            : removed === added
              ? `Upload cancelled. Removed the ${pluralize(added, "track")} it had already added.`
              : `Upload cancelled. Removed ${removed} of ${pluralize(added, "track")} it had added; delete the rest from your library.`,
        );
        return;
      }
      const message = uploadErrorMessage(err);
      setError(message);
      // Nothing went in: the selection stays, so Upload tries again. Once a
      // batch has, its results show, and the files after the failed request
      // (never sent) fail with its error, as on mobile.
      if (sent > 0) {
        setResults([
          ...uploaded,
          ...batches.flat().slice(sent).map((f) => ({ file: f.name, inserted: false, error: message })),
          ...tooLarge.map((f) => tooLargeUploadResult(f.name)),
        ]);
      }
    } finally {
      // After a cancel too: a batch the server finished as the cancel went
      // out never reached `uploaded`, and its tracks stay; the library shows
      // them rather than looking unchanged.
      if (ctrl.signal.aborted || uploadAddedAny(uploaded)) libraryChanged.emit();
      abortRef.current = null;
      setCancelling(false);
      setBusy(false);
    }
  };

  if (!mounted) return null;

  return (
    <div
      className="fixed inset-0 z-40"
      onDragOver={(e) => {
        e.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        if (busy) return;
        void filesFromDrop(e.dataTransfer).then(accept);
      }}
    >
      <DialogShell
        open={open}
        title="Add music"
        onClose={dismiss}
        closeDisabled={busy}
        footer={
          <DialogFooter>
            <Button variant="ghost" onClick={cancel} disabled={cancelling}>
              {results ? "Done" : cancelling ? "Cancelling…" : busy ? "Cancel upload" : "Cancel"}
            </Button>
            {!results && (
              <Button
                variant="primary"
                onClick={submit}
                disabled={busy || files.length === 0}
              >
                {busy
                  ? `Uploading ${progress} of ${files.length}…`
                  : `Upload ${files.length || ""}`.trim()}
              </Button>
            )}
          </DialogFooter>
        }
      >
        <div className="overflow-y-auto px-4 py-4">
          {isAdmin && (
            <Fieldset
              legend="Where should these files go?"
              style={{ margin: "0 0 16px" }}
            >
              <RadioCardOption
                name="upload-scope"
                value="global"
                checked={scope === "global"}
                onChange={() => setScope("global")}
                label="Global library"
                description="Visible to all users. Use this for the main shared collection."
              />
              <RadioCardOption
                name="upload-scope"
                value="personal"
                checked={scope === "personal"}
                onChange={() => setScope("personal")}
                label="Personal"
                description="Only you'll see these tracks alongside the global library."
              />
            </Fieldset>
          )}

          <label
            htmlFor="upload-files"
            style={{
              display: "grid",
              placeItems: "center",
              borderRadius: "var(--radius-lg)",
              border: `1px dashed ${dragActive ? "var(--ring)" : "var(--input)"}`,
              background: dragActive ? "var(--muted)" : "transparent",
              padding: "28px 16px",
              textAlign: "center",
              cursor: "pointer",
              transition: "background 120ms, border-color 120ms",
            }}
          >
            <ArrowUpTrayIcon
              className="size-4 shrink-0"
              style={{ color: "var(--muted-foreground)" }}
              aria-hidden="true"
            />
            <p style={{ marginTop: 10, fontSize: 14, color: "var(--foreground)" }}>
              {dragActive
                ? "Drop to add"
                : "Drop files or folders here, or click to choose files"}
            </p>
            <p
              className="mono"
              style={{ marginTop: 4, fontSize: 12, color: "var(--muted-foreground)" }}
            >
              MP3, FLAC, M4A, MP4, AAC, OGG, Opus, WAV, or WebM
            </p>
          </label>
          <input
            ref={inputRef}
            id="upload-files"
            name="files"
            type="file"
            multiple
            accept={ACCEPT}
            disabled={busy}
            className="sr-only"
            onChange={(e) => {
              accept(e.currentTarget.files);
              e.currentTarget.value = ""; // picking the same files again still fires
            }}
          />
          <input
            ref={folderRef}
            type="file"
            multiple
            // Folder pick (every browser and Electron); its files carry webkitRelativePath.
            {...{ webkitdirectory: "", directory: "" }}
            className="sr-only"
            aria-label="Choose a folder"
            onChange={(e) => {
              accept(e.currentTarget.files);
              e.currentTarget.value = "";
            }}
          />
          <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button variant="ghost" onClick={() => folderRef.current?.click()} disabled={busy}>
              <FolderIcon className="size-3.5" />
              Choose folder
            </Button>
            {(files.length > 0 || leftOut.length > 0) && !results && (
              <Button variant="ghost" onClick={clear} disabled={busy}>
                Clear
              </Button>
            )}
          </div>

          {files.length > 0 && !results && (
            <div style={{ marginTop: 12, fontSize: 14, color: "var(--foreground)" }}>
              {files.length} {files.length === 1 ? "file" : "files"} selected
              <ul
                className="mono"
                style={{
                  marginTop: 4,
                  maxHeight: 128,
                  overflowY: "auto",
                  fontSize: 12,
                  color: "var(--muted-foreground)",
                  listStyle: "none",
                  padding: 0,
                }}
              >
                {files.map((f, i) => (
                  <li
                    key={i}
                    style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {displayPath(f)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {leftOut.length > 0 && !results && (
            <p
              style={{ marginTop: 12, fontSize: 12, color: "var(--muted-foreground)" }}
            >
              {pluralize(leftOut.length, "file")} left out, not a format the
              server can add: {leftOut.join(", ")}
            </p>
          )}

          {files.length > 0 && !results && (
            <div style={{ marginTop: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
                <Switch checked={editing} onChange={setEditing} disabled={busy} aria-labelledby="upload-edit-label" />
                <span id="upload-edit-label">Edit details before uploading</span>
              </label>
              {editing && (
                // What was typed is read once, as the upload starts: it can't
                // change underneath it.
                <fieldset disabled={busy} style={{ margin: "10px 0 0", padding: 0, border: 0, minWidth: 0, display: "grid", gap: 10 }}>
                  <p style={{ margin: 0, fontSize: 12, color: "var(--muted-foreground)" }}>
                    Blank fields keep what the file's own tags say. Applied as each track is added;
                    tracks already in the library aren't changed.
                  </p>
                  <FieldRow>
                    <Field label="Album (all files)">
                      <TextInput value={album} onChange={(e) => setAlbum(e.target.value)} />
                    </Field>
                    <Field label="Album artist">
                      <TextInput value={albumArtist} onChange={(e) => setAlbumArtist(e.target.value)} />
                    </Field>
                  </FieldRow>
                  <Field label="Cover art (all files)" hint={scope === "global" && isAdmin ? "Becomes the album's cover." : "Only you see it."}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <Button variant="ghost" onClick={() => coverRef.current?.click()} disabled={busy}>
                        <PhotoIcon className="size-3.5" />
                        {cover ? "Change image" : "Choose image"}
                      </Button>
                      {cover && <span className="mono" style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{cover.name}</span>}
                      <input
                        ref={coverRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        aria-label="Cover art for all files"
                        hidden
                        onChange={(e) => setCover(e.currentTarget.files?.[0] ?? null)}
                      />
                    </div>
                  </Field>
                  <div style={{ maxHeight: 240, overflowY: "auto", display: "grid", gap: 8 }}>
                    {files.map((f, i) => (
                      <div key={i} style={{ display: "grid", gap: 4 }}>
                        <span className="mono" style={{ fontSize: 12, color: "var(--muted-foreground)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {displayPath(f)}
                        </span>
                        <FieldRow>
                          <TextInput
                            aria-label={`Title for ${displayPath(f)}`}
                            placeholder="Title (from tags)"
                            value={perFile.get(f)?.title ?? ""}
                            onChange={(e) => setFileField(f, "title", e.target.value)}
                          />
                          <TextInput
                            aria-label={`Artists for ${displayPath(f)}`}
                            placeholder="Artists, comma-separated (from tags)"
                            value={perFile.get(f)?.artists ?? ""}
                            onChange={(e) => setFileField(f, "artists", e.target.value)}
                          />
                        </FieldRow>
                      </div>
                    ))}
                  </div>
                </fieldset>
              )}
            </div>
          )}

          {results && (
            <ul style={{ marginTop: 14, listStyle: "none", padding: 0 }}>
              {results.map((r, i) => (
                <li
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    padding: "6px 0",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <StatusDot result={r} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p
                      style={{
                        fontSize: 14,
                        color: "var(--foreground)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        margin: 0,
                      }}
                    >
                      {r.file}
                    </p>
                    <p
                      className="mono"
                      style={{
                        fontSize: 12,
                        color: "var(--muted-foreground)",
                        margin: "2px 0 0",
                      }}
                    >
                      {uploadResultDetail(r)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {cancelNote && (
            <p role="status" style={{ marginTop: 12, fontSize: 13, color: "var(--muted-foreground)" }}>
              {cancelNote}
            </p>
          )}
          {error && <ErrorBanner className="mt-3" message={error} />}
        </div>
      </DialogShell>
    </div>
  );
}

function StatusDot({ result }: { result: UploadResult }) {
  const status = uploadResultStatus(result);
  if (status === "failed") {
    return (
      <span
        style={{
          display: "grid",
          placeItems: "center",
          width: 16,
          height: 16,
          color: "var(--destructive)",
          marginTop: 1,
        }}
      >
        <span
          style={{ width: 6, height: 6, borderRadius: 999, background: "currentColor" }}
        />
      </span>
    );
  }
  if (status === "added" || status === "duplicate") {
    return (
      <CheckIcon
        className="size-4 shrink-0"
        style={{ color: "var(--primary)", marginTop: 1 }}
        aria-hidden="true"
      />
    );
  }
  return (
    <span
      style={{
        display: "grid",
        placeItems: "center",
        width: 16,
        height: 16,
        color: "var(--muted-foreground)",
        marginTop: 1,
      }}
    >
      <span
        style={{ width: 6, height: 6, borderRadius: 999, background: "currentColor" }}
      />
    </span>
  );
}
