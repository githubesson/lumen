import { useEffect, useState } from "react";
import {
  api,
  albumCoverUrl,
  errorMessage,
  type Album,
  type TrackDetail,
  type TrackListItem,
} from "../../api";
import { Button } from "../Button";
import CoverArt from "../CoverArt";
import { DialogShell } from "../DialogShell";
import SearchInput from "../SearchInput";
import ErrorBanner from "../ErrorBanner";
import { libraryChanged } from "../../lib/events";

interface MoveToAlbumProps {
  open: boolean;
  /** The track being moved. Carries album_id so the current album is marked. */
  track: TrackListItem | null;
  onClose: () => void;
  onMoved?: (updated: TrackDetail) => void;
}

/**
 * Admin tool to move a track into an existing album. Unlike the album field in
 * the edit dialog (which upserts an album by name), this assigns the track's
 * album_id directly to a real album row picked from a searchable list — no risk
 * of accidentally spawning a near-duplicate album from a typo.
 */
export function MoveToAlbumDialog({
  open,
  track,
  onClose,
  onMoved,
}: MoveToAlbumProps) {
  const [query, setQuery] = useState("");
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);

  // Reset the search box each time the dialog (re)opens — stale results from
  // the last open, for a different track, would be confusing.
  useEffect(() => {
    if (open) {
      setQuery("");
      setError(null);
      setMovingId(null);
    }
  }, [open]);

  // Debounced album search. The /albums endpoint already does the substring
  // match server-side; this just throttles keystrokes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setAlbums(null);
    const handle = setTimeout(
      () => {
        api
          .listAlbumsPage({ q: query.trim() || undefined, limit: 50 })
          .then((page) => {
            if (!cancelled) setAlbums(page.items);
          })
          .catch((err) => {
            if (cancelled) return;
            setAlbums([]);
            setError(
              errorMessage(err, "Couldn't load albums."),
            );
          });
      },
      query ? 220 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, query]);

  const move = async (album: Album) => {
    if (!track || movingId) return;
    if (album.id === track.album_id) return;
    setMovingId(album.id);
    setError(null);
    try {
      const updated = await api.updateTrack(track.id, { album_id: album.id });
      libraryChanged.emit();
      onMoved?.(updated);
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Move failed."));
      setMovingId(null);
    }
  };

  return (
    <DialogShell open={open} title="Move to album" onClose={onClose}>
      <div className="px-4 py-4" style={{ display: "grid", gap: 12 }}>
        {track && (
          <div style={{ fontSize: 12.5, color: "var(--fg-muted)" }}>
            Moving{" "}
            <span style={{ color: "var(--fg)", fontWeight: 500 }}>
              {track.title}
            </span>
            {track.album_title
              ? ` — currently in ${track.album_title}`
              : " — not in an album yet"}
          </div>
        )}
        <SearchInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search albums"
          autoFocus
        />
        <div
          style={{
            display: "grid",
            gap: 2,
            maxHeight: "44vh",
            overflowY: "auto",
            margin: "0 -4px",
            padding: "0 4px",
          }}
        >
          {albums === null && (
            <div
              className="mono"
              style={{ color: "var(--fg-subtle)", fontSize: 11, padding: 8 }}
            >
              Loading…
            </div>
          )}
          {albums && albums.length === 0 && (
            <div
              className="mono"
              style={{ color: "var(--fg-subtle)", fontSize: 11, padding: 8 }}
            >
              No albums match.
            </div>
          )}
          {albums?.map((a) => {
            const isCurrent = a.id === track?.album_id;
            const busy = movingId === a.id;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => void move(a)}
                disabled={isCurrent || movingId !== null}
                className="album-pick-row"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  padding: 6,
                  borderRadius: "var(--r-md)",
                  border: "1px solid transparent",
                  background: "transparent",
                  textAlign: "left",
                  cursor: isCurrent ? "default" : "pointer",
                  opacity: isCurrent || (movingId !== null && !busy) ? 0.5 : 1,
                }}
              >
                <CoverArt
                  src={a.has_cover ? albumCoverUrl(a.id, 80) : null}
                  seed={a.id}
                  label={a.title}
                  size={40}
                  radius={6}
                  forcePlaceholder={!a.has_cover}
                />
                <div style={{ flex: 1, overflow: "hidden" }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {a.title}
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
                    {a.artist_name ||
                      (a.is_compilation ? "Various Artists" : "Unknown artist")}{" "}
                    · {a.track_count}{" "}
                    {a.track_count === 1 ? "track" : "tracks"}
                  </div>
                </div>
                {isCurrent && (
                  <span
                    className="mono"
                    style={{ fontSize: 10, color: "var(--fg-subtle)" }}
                  >
                    Current
                  </span>
                )}
                {busy && (
                  <span
                    className="mono"
                    style={{ fontSize: 10, color: "var(--fg-subtle)" }}
                  >
                    …
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {error && <ErrorBanner message={error} />}
        <div
          style={{ display: "flex", justifyContent: "flex-end", paddingTop: 4 }}
        >
          <Button variant="ghost" onClick={onClose} disabled={movingId !== null}>
            Cancel
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}
