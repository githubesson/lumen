import { FormEvent, useState } from "react";
import {
  LogOut as LogOutIcon,
  UserMinus as UserMinusIcon,
  UserPlus as UserPlusIcon,
} from "lucide-react";
import {
  api,
  errorMessage,
  type Collaborator,
  type CollaboratorRole,
} from "../../api";
import { Button } from "../../components/Button";
import ErrorBanner from "../../components/ErrorBanner";
import EmptyState from "../../components/EmptyState";
import { Field, NativeSelect, TextInput } from "../../components/Field";
import { useConfirm, type ConfirmSubject } from "../../context/Confirm";
import { fmtDate } from "../../lib/format";
import {
  collaboratorPermissions,
  type PlaylistPermissions,
  type PlaylistViewer,
} from "@music-library/core/playlist-permissions";

export default function CollaboratorsPanel({
  playlistId,
  collaborators,
  permissions,
  me,
  onChanged,
  onLeft,
  subject,
}: {
  playlistId: string;
  collaborators: Collaborator[];
  permissions: PlaylistPermissions;
  me: PlaylistViewer;
  onChanged: () => Promise<void>;
  /** After you remove yourself, which ends your access to the playlist. */
  onLeft: () => void;
  /** The playlist, as the confirmation to leave it shows it. */
  subject?: () => ConfirmSubject;
}) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<CollaboratorRole>("editor");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.inviteCollaborator(playlistId, { username: username.trim(), role });
      setUsername("");
      await onChanged();
    } catch (err) {
      setError(errorMessage(err, "Failed to send invite."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: Collaborator, isSelf: boolean) => {
    const pending = c.status === "pending";
    const confirmed = await confirm(
      isSelf
        ? {
            title: "Leave this playlist?",
            message: "You lose access to it unless you're invited again.",
            subject: subject?.(),
            confirmLabel: "Leave",
            confirmIcon: LogOutIcon,
          }
        : {
            title: pending ? "Withdraw this invite?" : "Remove from this playlist?",
            message: pending
              ? "They can't join the playlist with it anymore."
              : "They lose access to the playlist.",
            subject: {
              art: { person: c.username },
              name: c.username,
              detail: `${c.role === "editor" ? "Editor" : "Viewer"} · ${pending ? "Invite pending" : "Accepted"}`,
            },
            confirmLabel: pending ? "Withdraw" : "Remove",
            confirmIcon: UserMinusIcon,
          },
    );
    if (!confirmed) return;
    try {
      await api.removeCollaborator(playlistId, c.user_id);
      if (isSelf) onLeft();
      else await onChanged();
    } catch (err) {
      setError(errorMessage(err, isSelf ? "Failed to leave." : "Failed to remove."));
    }
  };

  const setRoleFor = async (userId: string, r: CollaboratorRole) => {
    try {
      await api.setCollaboratorRole(playlistId, userId, r);
      await onChanged();
    } catch (err) {
      setError(errorMessage(err, "Failed to update role."));
    }
  };

  return (
    <div style={{ display: "grid", gap: 20 }}>
      {permissions.canInvite && (
        <form
          onSubmit={invite}
          className="surface"
          style={{
            padding: 16,
            display: "grid",
            gap: 12,
            gridTemplateColumns: "minmax(0, 1fr) auto auto",
            alignItems: "end",
          }}
        >
          <Field label="Invite by username">
            <TextInput
              name="username"
              placeholder="e.g. alice"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </Field>
          <Field label="Role">
            <NativeSelect
              value={role}
              onChange={(e) => setRole(e.target.value as CollaboratorRole)}
            >
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </NativeSelect>
          </Field>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || username.trim().length === 0}
            leadingIcon={<UserPlusIcon className="size-4" />}
          >
            Invite
          </Button>
        </form>
      )}

      {error && <ErrorBanner message={error} />}

      {collaborators.length === 0 ? (
        <EmptyState title="No collaborators yet." />
      ) : (
        <div className="surface">
          {collaborators.map((c, i) => {
            const row = collaboratorPermissions(permissions, c, me);
            return (
              <div
                key={c.user_id}
                style={{
                  padding: "12px 16px",
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  borderTop: i === 0 ? "0" : "1px solid var(--border)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: "var(--foreground)" }}>
                    {c.username}
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: 12, color: "var(--muted-foreground)" }}
                  >
                    {c.status === "pending" ? "Invite pending" : "Accepted"} ·{" "}
                    {fmtDate(c.invited_at)}
                  </div>
                </div>
                {row.canChangeRole ? (
                  <NativeSelect
                    style={{ width: 110 }}
                    value={c.role}
                    onChange={(e) =>
                      void setRoleFor(c.user_id, e.target.value as CollaboratorRole)
                    }
                    aria-label={`Role for ${c.username}`}
                  >
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </NativeSelect>
                ) : (
                  <span className="badge">{c.role}</span>
                )}
                {row.canRemove && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void remove(c, row.isSelf)}
                    leadingIcon={<UserMinusIcon className="size-3.5" />}
                  >
                    {row.isSelf ? "Leave" : "Remove"}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
