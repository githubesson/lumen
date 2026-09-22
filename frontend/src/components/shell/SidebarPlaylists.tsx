import { Link, NavLink } from "react-router-dom";
import { Plus as PlusIcon, ListMusic as QueueListIcon } from "lucide-react";
import type { Playlist } from "../../api";
import { useTheme } from "../../context/Theme";
import NavItem from "./NavItem";

export default function SidebarPlaylists({
  playlists,
}: {
  playlists: Playlist[];
}) {
  const { layout } = useTheme();
  return (
    <div className="sidebar-playlists">
      <div className="nav-section-title">
        <span>Playlists</span>
        <Link
          to="/playlists/new"
          className="iconbtn"
          style={{ width: 22, height: 22 }}
          aria-label="New playlist"
          title="New playlist"
        >
          <PlusIcon className="size-3" />
        </Link>
      </div>
      <NavItem
        to="/playlists"
        end
        icon={<QueueListIcon className="nav-icon" />}
        label="All playlists"
      />
      {playlists.length === 0 && (
        <div
          className="mono sidebar-playlists-empty"
          style={{
            padding: "4px 10px",
            fontSize: 12,
            color: "var(--muted-foreground)",
          }}
        >
          None yet
        </div>
      )}
      {playlists.map((p) => (
        <NavLink
          key={p.id}
          to={`/playlists/${p.id}`}
          title={layout === "compact" ? p.name : undefined}
          data-tooltip-side="right"
          className={({ isActive }) =>
            "sidebar-playlist" + (isActive ? " active" : "")
          }
        >
          <QueueListIcon className="sidebar-playlist-icon" aria-hidden="true" />
          <span className="sidebar-playlist-name">{p.name}</span>
        </NavLink>
      ))}
    </div>
  );
}
