import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, type PendingInvite } from "../api";
import { Button } from "../components/Button";
import DataState from "../components/DataState";
import PageHeader from "../components/PageHeader";

export default function PendingInvites() {
  const [rows, setRows] = useState<PendingInvite[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.listPendingInvites();
      setRows(d ?? []);
    } catch (err) {
      setError(errorMessage(err, "Failed to load invites."));
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const accept = async (id: string) => {
    try {
      await api.acceptInvite(id);
      await load();
    } catch (err) {
      setError(errorMessage(err, "Failed to accept."));
    }
  };
  const decline = async (id: string) => {
    try {
      await api.declineInvite(id);
      await load();
    } catch (err) {
      setError(errorMessage(err, "Failed to decline."));
    }
  };

  return (
    <div className="view">
      <PageHeader
        title="Playlist invites"
        count={rows ? `${rows.length} pending` : "—"}
      />

      <p style={{ color: "var(--fg-muted)", fontSize: 13, marginTop: 8, maxWidth: "60ch" }}>
        Other users can invite you to their collaborative playlists. Accepted
        playlists show up in your sidebar; declined invites are dismissed silently.
      </p>

      <DataState
        data={rows}
        error={error}
        empty={(data) => data.length === 0}
        emptyState={
          <p style={{ marginTop: 20, color: "var(--fg-muted)", fontSize: 13 }}>
            No pending invites.
          </p>
        }
        style={{ marginTop: 16 }}
      >
        {(invites) => (
          <div className="surface" style={{ marginTop: 20 }}>
            {invites.map((inv) => (
              <PendingInviteRow
                key={inv.playlist_id}
                invite={inv}
                onAccept={accept}
                onDecline={decline}
              />
            ))}
          </div>
        )}
      </DataState>
    </div>
  );
}

function PendingInviteRow({
  invite,
  onAccept,
  onDecline,
}: {
  invite: PendingInvite;
  onAccept: (id: string) => void;
  onDecline: (id: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "14px 18px",
        borderTop: "1px solid var(--border-soft)",
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg)" }}>
          {invite.playlist_name}
        </div>
        <div
          className="mono"
          style={{ fontSize: 10.5, color: "var(--fg-subtle)" }}
        >
          {invite.owner_name} invited you as {invite.role} ·{" "}
          {new Date(invite.invited_at).toLocaleDateString()}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Button
          size="sm"
          variant="primary"
          onClick={() => void onAccept(invite.playlist_id)}
        >
          Accept
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void onDecline(invite.playlist_id)}
        >
          Decline
        </Button>
      </div>
    </div>
  );
}
