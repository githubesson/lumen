import { FormEvent, useState } from "react";
import { UserMinusIcon, UserPlusIcon } from "@heroicons/react/16/solid";
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

export default function CollaboratorsPanel({
  playlistId,
  collaborators,
  isOwner,
  canInvite,
  onChanged,
}: {
  playlistId: string;
  collaborators: Collaborator[];
  isOwner: boolean;
  canInvite: boolean;
  onChanged: () => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<CollaboratorRole>("editor");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const remove = async (userId: string) => {
    if (!window.confirm("Remove this collaborator?")) return;
    try {
      await api.removeCollaborator(playlistId, userId);
      await onChanged();
    } catch (err) {
      setError(errorMessage(err, "Failed to remove."));
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
      {canInvite && (
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
          {collaborators.map((c, i) => (
            <div
              key={c.user_id}
              style={{
                padding: "12px 16px",
                display: "flex",
                alignItems: "center",
                gap: 16,
                borderTop: i === 0 ? "0" : "1px solid var(--border-soft)",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg)" }}>
                  {c.username}
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 10.5, color: "var(--fg-subtle)" }}
                >
                  {c.status === "pending" ? "Invite pending" : "Accepted"} ·{" "}
                  {new Date(c.invited_at).toLocaleDateString()}
                </div>
              </div>
              {isOwner && c.status === "accepted" ? (
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
              {isOwner && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void remove(c.user_id)}
                  leadingIcon={<UserMinusIcon className="size-3.5" />}
                >
                  Remove
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
