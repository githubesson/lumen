import { useRef, useState } from "react";
import { ArrowUpTrayIcon, CheckIcon } from "@heroicons/react/16/solid";
import { api, errorMessage, type UploadResult } from "../api";
import { Button } from "./Button";
import DialogFooter from "./DialogFooter";
import ErrorBanner from "./ErrorBanner";
import Fieldset from "./Fieldset";
import RadioCardOption from "./RadioCardOption";
import { DialogShell } from "./DialogShell";
import { libraryChanged } from "../lib/events";
import { AUDIO_EXTENSIONS, isAudioFile } from "../lib/download";
import { useTransitionMount } from "../lib/useTransitionMount";

type Scope = "personal" | "global";

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
  const [scope, setScope] = useState<Scope>(isAdmin ? "global" : "personal");
  const [files, setFiles] = useState<File[]>([]);
  const [results, setResults] = useState<UploadResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = (list: FileList | File[] | null) => {
    if (!list) return;
    const arr: File[] = Array.from(list).filter(isAudio);
    if (arr.length === 0) return;
    setFiles(arr);
    setResults(null);
    setError(null);
  };

  const submit = async () => {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.uploadMusic(files, scope);
      setResults(r);
      const anyInserted = r.some((x) => x.inserted);
      if (anyInserted) libraryChanged.emit();
      onComplete?.();
    } catch (err) {
      setError(errorMessage(err, "Upload failed."));
    } finally {
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
        accept(e.dataTransfer.files);
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
                {busy ? "Uploading…" : `Upload ${files.length || ""}`.trim()}
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
              borderRadius: "var(--r-md)",
              border: `1px dashed ${dragActive ? "color-mix(in oklch, var(--accent) 60%, var(--border))" : "var(--border)"}`,
              background: dragActive
                ? "color-mix(in oklch, var(--accent) 10%, var(--bg-inset))"
                : "var(--bg-inset)",
              boxShadow: "var(--shadow-inset)",
              padding: "28px 16px",
              textAlign: "center",
              cursor: "pointer",
              transition: "background 120ms, border-color 120ms",
            }}
          >
            <ArrowUpTrayIcon
              className="size-4 shrink-0"
              style={{ color: "var(--fg-muted)" }}
              aria-hidden="true"
            />
            <p style={{ marginTop: 10, fontSize: 13, color: "var(--fg)" }}>
              {dragActive
                ? "Drop to add"
                : "Drop files here, or click to choose"}
            </p>
            <p
              className="mono"
              style={{ marginTop: 4, fontSize: 11, color: "var(--fg-subtle)" }}
            >
              MP3, FLAC, M4A, OGG, Opus, or WAV
            </p>
          </label>
          <input
            ref={inputRef}
            id="upload-files"
            name="files"
            type="file"
            multiple
            accept={`audio/*,${AUDIO_EXTENSIONS.map((e) => `.${e}`).join(",")}`}
            className="sr-only"
            onChange={(e) => accept(e.currentTarget.files)}
          />

          {files.length > 0 && !results && (
            <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--fg)" }}>
              {files.length} {files.length === 1 ? "file" : "files"} selected
              <ul
                className="mono"
                style={{
                  marginTop: 4,
                  maxHeight: 128,
                  overflowY: "auto",
                  fontSize: 10.5,
                  color: "var(--fg-subtle)",
                  listStyle: "none",
                  padding: 0,
                }}
              >
                {files.map((f) => (
                  <li
                    key={f.name}
                    style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {f.name}
                  </li>
                ))}
              </ul>
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
                    borderBottom: "1px solid var(--border-soft)",
                  }}
                >
                  <StatusDot result={r} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p
                      style={{
                        fontSize: 12.5,
                        color: "var(--fg)",
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
                        fontSize: 10.5,
                        color: "var(--fg-subtle)",
                        margin: "2px 0 0",
                      }}
                    >
                      {resultLabel(r)}
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

function isAudio(f: File) {
  return f.type.startsWith("audio/") || isAudioFile(f.name);
}

function resultLabel(r: UploadResult) {
  if (r.error) return r.error;
  if (r.skipped) return "Skipped (unsupported format)";
  if (r.inserted) return "Added";
  if (r.dedup) return "Already in library";
  return "Uploaded";
}

function StatusDot({ result }: { result: UploadResult }) {
  if (result.error) {
    return (
      <span
        style={{
          display: "grid",
          placeItems: "center",
          width: 16,
          height: 16,
          color: "var(--danger-fg)",
          marginTop: 1,
        }}
      >
        <span
          style={{ width: 6, height: 6, borderRadius: 999, background: "currentColor" }}
        />
      </span>
    );
  }
  if (result.inserted || result.dedup) {
    return (
      <CheckIcon
        className="size-4 shrink-0"
        style={{ color: "var(--accent)", marginTop: 1 }}
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
        color: "var(--fg-subtle)",
        marginTop: 1,
      }}
    >
      <span
        style={{ width: 6, height: 6, borderRadius: 999, background: "currentColor" }}
      />
    </span>
  );
}
