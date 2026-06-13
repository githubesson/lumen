import { useEffect, useState } from "react";
import {
  api,
  errorMessage,
  trackCoverUrl,
  type TrackListItem,
} from "../../api";
import { Button } from "../../components/Button";
import DialogFooter from "../../components/DialogFooter";
import { DialogShell } from "../../components/DialogShell";
import SearchInput from "../../components/SearchInput";
import { displayText, fmtDurationMs } from "../../lib/format";

export default function AddTracksDialog({
  open,
  playlistId,
  existingIds,
  onClose,
  onAdded,
}: {
  open: boolean;
  playlistId: string;
  existingIds: Set<string>;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [query, setQuery] = useState("");
  const [tracks, setTracks] = useState<TrackListItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      const q = query.trim();
      const req = q
        ? api.searchTracks({ q, limit: 50 }).then((res) => {
            if (!cancelled) setError(res.warnings?.join(" ") || null);
            return res.tracks ?? [];
          })
        : api.listTracks({ limit: 200 }).then((res) => {
            if (!cancelled) setError(null);
            return res;
          });
      req
        .then((d) => !cancelled && setTracks(d ?? []))
        .catch((err) => {
          if (!cancelled) {
            setTracks([]);
            setError(errorMessage(err, "Search failed."));
          }
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.addPlaylistTracks(playlistId, Array.from(selected));
      onAdded();
    } catch (err) {
      setError(errorMessage(err, "Failed to add tracks."));
      setBusy(false);
    }
  };

  const isExisting = (track: TrackListItem) => {
    if (existingIds.has(track.id)) return true;
    if (track.db_track_id && existingIds.has(track.db_track_id)) return true;
    if (track.source === "local" && track.db_track_id && existingIds.has(`local:${track.db_track_id}`)) {
      return true;
    }
    if (track.source === "local" && track.source_id && existingIds.has(`local:${track.source_id}`)) {
      return true;
    }
    if (track.source === "tidal" && track.source_id && existingIds.has(`tidal:${track.source_id}`)) {
      return true;
    }
    return false;
  };

  return (
    <DialogShell
      open={open}
      title="Add tracks"
      onClose={onClose}
      maxWidth={560}
      footer={
        <DialogFooter
          style={{ padding: "14px 18px", gap: 12 }}
          start={
            <>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-subtle)" }}>
                {selected.size} selected
              </span>
              {error && (
                <span
                  role="alert"
                  style={{ fontSize: 12, color: "var(--danger-fg)", flex: 1, textAlign: "right" }}
                >
                  {error}
                </span>
              )}
            </>
          }
        >
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={busy || selected.size === 0}
          >
            {busy ? "Adding..." : `Add ${selected.size}`}
          </Button>
        </DialogFooter>
      }
    >
      <div style={{ overflowY: "auto", padding: 18 }}>
        <SearchInput
          autoFocus
          placeholder="Search local + TIDAL"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search tracks"
        />
        <ul style={{ marginTop: 12, listStyle: "none", padding: 0 }}>
          {tracks.map((t) => {
            const disabled = isExisting(t);
            const sel = selected.has(t.id);
            return (
              <li key={t.id}>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "8px 4px",
                    borderBottom: "1px solid var(--border-soft)",
                    cursor: disabled ? "not-allowed" : "pointer",
                    opacity: disabled ? 0.5 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={sel}
                    disabled={disabled}
                    onChange={() => toggle(t.id)}
                    style={{ accentColor: "var(--accent)" }}
                  />
                  <div
                    className="mini-art"
                    style={{
                      backgroundImage: `url(${trackCoverUrl(t)})`,
                      width: 32,
                      height: 32,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {displayText(t.title)}
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 10.5,
                        color: "var(--fg-subtle)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {displayText(t.artist, "Unknown") +
                        (t.album_title ? ` - ${displayText(t.album_title)}` : "") +
                        (t.source === "tidal" ? " - TIDAL" : "") +
                        (disabled ? " - already added" : "")}
                    </div>
                  </div>
                  <span
                    className="mono"
                    style={{ color: "var(--fg-subtle)", fontSize: 10.5 }}
                  >
                    {fmtDurationMs(t.duration_ms)}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>
    </DialogShell>
  );
}
