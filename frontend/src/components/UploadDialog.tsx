import { useRef, useState } from "react";
import { Upload as ArrowUpTrayIcon, Check as CheckIcon, FolderOpen as FolderIcon } from "lucide-react";
import { api, errorMessage, type UploadResult } from "../api";
import { Button } from "./Button";
import DialogFooter from "./DialogFooter";
import ErrorBanner from "./ErrorBanner";
import Fieldset from "./Fieldset";
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
  tooLargeUploadResult,
  UPLOAD_EXTENSIONS,
  uploadAddedAny,
  uploadResultDetail,
  uploadResultStatus,
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
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  // Picks and drops add to the selection, so files and folders can be mixed.
  const accept = (list: FileList | File[] | null) => {
    if (!list || list.length === 0) return;
    const all = Array.from(list);
    const base = results ? [] : files;
    setFiles(mergeFiles(base, all.filter((f) => isUploadableFile(f.name))));
    setLeftOut((prev) => [...(results ? [] : prev), ...all.filter((f) => !isUploadableFile(f.name)).map(displayPath)]);
    setResults(null);
    setError(null);
  };

  const clear = () => {
    setFiles([]);
    setLeftOut([]);
  };

  const submit = async () => {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    // One request over the server's cap fails whole, so a big selection goes
    // up in batches, one after another. A file too big to send at all is
    // reported with the rest rather than sent.
    const { batches, tooLarge } = planUploadBatches(files, (f) => f.size);
    const uploaded: UploadResult[] = [];
    let sent = 0;
    setProgress(0);
    try {
      for (const batch of batches) {
        // Only admins may upload to the shared library; the choice is hidden
        // from everyone else.
        uploaded.push(...(await api.uploadMusic(batch, uploadScope(isAdmin, scope))));
        sent += batch.length;
        setProgress(sent);
      }
      setResults([...uploaded, ...tooLarge.map((f) => tooLargeUploadResult(f.name))]);
      onComplete?.();
    } catch (err) {
      const message = errorMessage(err, "Upload failed.");
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
      if (uploadAddedAny(uploaded)) libraryChanged.emit();
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
        onClose={onClose}
        footer={
          <DialogFooter>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {results ? "Done" : "Cancel"}
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
