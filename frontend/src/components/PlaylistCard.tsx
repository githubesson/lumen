import { Link } from "react-router-dom";
import { LockClosedIcon, UsersIcon } from "@heroicons/react/16/solid";
import { type Playlist } from "../api";
import { swatchFor } from "../lib/swatch";

/**
 * One canonical playlist tile so a playlist looks identical on Home and the
 * Playlists page (previously each rendered its own slightly different card).
 */
export default function PlaylistCard({ playlist }: { playlist: Playlist }) {
  const isCollab = playlist.visibility === "collaborative";
  return (
    <Link to={`/playlists/${playlist.id}`} className="card">
      <div
        className="card-art"
        style={{ background: swatchFor(playlist.id) }}
        aria-hidden="true"
      />
      <div>
        <div
          className="card-title"
          style={{ display: "flex", alignItems: "center", gap: 6 }}
        >
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
            {playlist.name}
          </span>
          {isCollab ? (
            <UsersIcon
              className="size-3"
              style={{ color: "var(--fg-subtle)", flex: "0 0 12px" }}
            />
          ) : (
            <LockClosedIcon
              className="size-3"
              style={{ color: "var(--fg-subtle)", flex: "0 0 12px" }}
            />
          )}
        </div>
        <div className="card-sub">
          {playlist.effective_role && playlist.effective_role !== "owner"
            ? playlist.effective_role
            : playlist.visibility}
        </div>
      </div>
    </Link>
  );
}
