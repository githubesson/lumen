import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, type PendingInvite } from "../api";
import { Button } from "../components/Button";
import ErrorBanner from "../components/ErrorBanner";
import LoadingState from "../components/LoadingState";

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
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <h1
          style={{
            fontSize: 28,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            margin: 0,
          }}
        >
          Playlist invites
        </h1>
        <div className="mono" style={{ color: "var(--fg-subtle)", fontSize: 11 }}>
          {rows ? `${rows.length} pending` : "—"}
        </div>
      </header>

      <p style={{ color: "var(--fg-muted)", fontSize: 13, marginTop: 8, maxWidth: "60ch" }}>
        Other users can invite you to their collaborative playlists. Accepted
        playlists show up in your sidebar; declined invites are dismissed silently.
      </p>

      {error && (
        <div style={{ marginTop: 16 }}>
          <ErrorBanner message={error} />
        </div>
      )}

      {rows === null && <LoadingState />}

      {rows && rows.length === 0 && (
        <p style={{ marginTop: 20, color: "var(--fg-muted)", fontSize: 13 }}>
          No pending invites.
        </p>
      )}

      {rows && rows.length > 0 && (
        <div className="surface" style={{ marginTop: 20 }}>
          {rows.map((inv, i) => (
            <div
              key={inv.playlist_id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                padding: "14px 18px",
                borderTop: i === 0 ? "0" : "1px solid var(--border-soft)",
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg)" }}>
                  {inv.playlist_name}
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 10.5, color: "var(--fg-subtle)" }}
                >
                  {inv.owner_name} invited you as {inv.role} ·{" "}
                  {new Date(inv.invited_at).toLocaleDateString()}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void accept(inv.playlist_id)}
                >
                  Accept
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void decline(inv.playlist_id)}
                >
                  Decline
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
