import { useState } from "react";
import {
  api,
  ApiError,
  errorMessage,
  type AdminUser,
  type PlaylistDisposition,
  type UserDeparturePreview,
} from "../../api";
import { Button } from "../../components/Button";
import DialogFooter from "../../components/DialogFooter";
import { DialogShell } from "../../components/DialogShell";
import ErrorBanner from "../../components/ErrorBanner";
import { NativeSelect } from "../../components/Field";
import { useApiResource } from "../../lib/useApiResource";

const DELETE = "delete";

type OwnedPlaylist = UserDeparturePreview["owned_playlists"][number];

/**
 * Deleting a user: their playlists can't be left without an owner, so each one
 * goes to someone else (their longest-standing collaborator by default, else
 * the admin doing the deleting) or is deleted. Mount it fresh for each user
 * (key it) so the preview is current.
 */
export function DeleteUserDialog({
  user,
  users,
  meId,
  open,
  onClose,
  onDeleted,
}: {
  user: AdminUser;
  users: AdminUser[];
  meId: string | undefined;
  open: boolean;
  onClose: () => void;
  onDeleted: () => void | Promise<void>;
}) {
  const {
    data: preview,
    error: previewError,
    reload: reloadPreview,
  } = useApiResource<UserDeparturePreview>(
    (signal) => api.userDeparturePreview(user.id, { signal }),
    "Couldn't load their playlists.",
  );
  // Only the choices the admin changed; everything else uses its default, so
  // a playlist that shows up on a refreshed preview gets one too.
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const heirs = users.filter((u) => u.id !== user.id && !u.disabled);
  const defaultChoice = (p: OwnedPlaylist) => {
    if (p.suggested_heir_id && heirs.some((u) => u.id === p.suggested_heir_id)) {
      return p.suggested_heir_id;
    }
    if (meId && heirs.some((u) => u.id === meId)) return meId;
    return heirs[0]?.id ?? DELETE;
  };
  const choiceFor = (p: OwnedPlaylist) => choices[p.playlist_id] ?? defaultChoice(p);
  const options = [
    ...heirs.map((u) => ({
      value: u.id,
      label: `Give to ${u.username}${u.id === meId ? " (you)" : ""}`,
    })),
    { value: DELETE, label: "Delete playlist" },
  ];

  const submit = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setError(null);
    const dispositions: PlaylistDisposition[] = preview.owned_playlists.map((p) => {
      const choice = choiceFor(p);
      return choice === DELETE
        ? { playlist_id: p.playlist_id, action: "delete" }
        : { playlist_id: p.playlist_id, action: "transfer", new_owner_id: choice };
    });
    try {
      await api.deleteUser(user.id, dispositions);
      await onDeleted();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // They made a playlist since the preview loaded.
        setError("They own playlists that weren't listed yet. Check them below, then try again.");
        await reloadPreview();
      } else {
        setError(errorMessage(err, `Couldn't delete ${user.username}.`));
      }
    } finally {
      setBusy(false);
    }
  };

  // Ignored mid-request: the dialog is where its result or error shows up.
  const close = () => {
    if (!busy) onClose();
  };

  const owned = preview?.owned_playlists ?? [];
  return (
    <DialogShell
      open={open}
      title={`Delete ${user.username}?`}
      onClose={close}
      footer={
        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => void submit()}
            disabled={busy || !preview}
          >
            {busy ? "Deleting…" : `Delete ${user.username}`}
          </Button>
        </DialogFooter>
      }
    >
      <div
        className="overflow-y-auto px-4 py-4"
        style={{ display: "grid", gap: 12, fontSize: 14 }}
      >
        {(error || previewError) && <ErrorBanner message={error ?? previewError ?? ""} />}
        <p style={{ margin: 0 }}>
          Their account, personal uploads, favorites and play history are
          removed. This can&apos;t be undone.
        </p>
        {!preview && !previewError && (
          <p className="mono" style={{ margin: 0, color: "var(--muted-foreground)" }}>
            Checking their playlists…
          </p>
        )}
        {owned.length > 0 && (
          <>
            <p style={{ margin: 0, color: "var(--muted-foreground)" }}>
              {owned.length === 1
                ? "They own a playlist. Choose what happens to it:"
                : `They own ${owned.length} playlists. Choose what happens to each:`}
            </p>
            <div style={{ display: "grid", gap: 8 }}>
              {owned.map((p) => (
                <div
                  key={p.playlist_id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) 220px",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={p.name}
                  >
                    {p.name}
                  </span>
                  <NativeSelect
                    aria-label={`What happens to ${p.name}`}
                    value={choiceFor(p)}
                    disabled={busy}
                    onChange={(e) =>
                      setChoices((c) => ({ ...c, [p.playlist_id]: e.target.value }))
                    }
                  >
                    {options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </DialogShell>
  );
}
