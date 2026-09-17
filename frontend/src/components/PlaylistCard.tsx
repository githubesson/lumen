import { Link } from "react-router-dom";
import {
  ListMusic as QueueListIcon,
  Lock as LockClosedIcon,
  Users as UsersIcon,
} from "lucide-react";
import { type Playlist } from "../api";

/**
 * One canonical playlist tile so a playlist looks identical on Home and the
 * Playlists page (previously each rendered its own slightly different card).
 */
export default function PlaylistCard({ playlist }: { playlist: Playlist }) {
  const isCollab = playlist.visibility === "collaborative";
  return (
    <Link to={`/playlists/${playlist.id}`} className="card">
      <div className="card-art card-art-icon" aria-hidden="true">
        <QueueListIcon className="size-8" />
      </div>
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
              style={{ color: "var(--muted-foreground)", flex: "0 0 12px" }}
            />
          ) : (
            <LockClosedIcon
              className="size-3"
              style={{ color: "var(--muted-foreground)", flex: "0 0 12px" }}
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
