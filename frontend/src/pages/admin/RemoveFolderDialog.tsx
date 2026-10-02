import {
  musicRootName,
  musicRootRemoval,
} from "@music-library/core/admin/music-roots";
import { useState } from "react";
import { api, errorMessage, type MusicRoot } from "../../api";
import { Button } from "../../components/Button";
import DialogFooter from "../../components/DialogFooter";
import { DialogShell } from "../../components/DialogShell";
import ErrorBanner from "../../components/ErrorBanner";

/**
 * Removing a folder asks one question: what happens to its tracks. It replaces
 * two confirm boxes where the second one's "Cancel" meant "remove the folder
 * but keep its tracks".
 */
export function RemoveFolderDialog({
  root,
  open,
  onClose,
  onRemoved,
}: {
  root: MusicRoot | null;
  open: boolean;
  onClose: () => void;
  onRemoved: (result: { purged: boolean; deletedTracks: number }) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<"keep" | "purge" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { canPurge, coveredBy } = musicRootRemoval(root ?? {});

  const remove = async (purge: boolean) => {
    if (!root || busy || (purge && !canPurge)) return;
    setBusy(purge ? "purge" : "keep");
    setError(null);
    try {
      const res = await api.deleteMusicRoot(root.id, { purge });
      await onRemoved({ purged: purge, deletedTracks: res?.deleted_tracks ?? 0 });
    } catch (err) {
      setError(errorMessage(err, "Couldn't remove the folder."));
    } finally {
      setBusy(null);
    }
  };

  // Ignored mid-request: the dialog is where its result or error shows up.
  const close = () => {
    if (busy) return;
    setError(null);
    onClose();
  };

  const name = root ? musicRootName(root) : "";
  return (
    <DialogShell
      open={open}
      title={`Remove ${name}?`}
      onClose={close}
      footer={
        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy !== null}>
            Cancel
          </Button>
          {!canPurge ? (
            <Button
              variant="danger"
              onClick={() => void remove(false)}
              disabled={busy !== null}
            >
              {busy ? "Removing…" : "Remove folder"}
            </Button>
          ) : (
            <>
              <Button onClick={() => void remove(false)} disabled={busy !== null}>
                {busy === "keep" ? "Removing…" : "Keep tracks"}
              </Button>
              <Button
                variant="danger"
                onClick={() => void remove(true)}
                disabled={busy !== null}
              >
                {busy === "purge" ? "Removing…" : "Remove tracks"}
              </Button>
            </>
          )}
        </DialogFooter>
      }
    >
      <div
        className="overflow-y-auto px-4 py-4"
        style={{ display: "grid", gap: 10, fontSize: 14 }}
      >
        {error && <ErrorBanner message={error} />}
        <p style={{ margin: 0 }}>
          Lumen stops watching{" "}
          <span className="font-mono" style={{ wordBreak: "break-all" }}>
            {root?.path}
          </span>{" "}
          as its own folder. Nothing on disk is deleted.
        </p>
        {coveredBy ? (
          <p style={{ margin: 0, color: "var(--muted-foreground)" }}>
            It&apos;s inside{" "}
            <span className="font-mono" style={{ wordBreak: "break-all" }}>
              {coveredBy}
            </span>
            , which is still watched, so its tracks stay in your library.
          </p>
        ) : (
          <p style={{ margin: 0, color: "var(--muted-foreground)" }}>
            Should its tracks leave your library too? Kept tracks stay in
            playlists and play history but won&apos;t play until you add the
            folder back.
          </p>
        )}
      </div>
    </DialogShell>
  );
}
