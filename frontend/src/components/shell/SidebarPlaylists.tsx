import { Link, NavLink } from "react-router-dom";
import {
  ChevronDown as ChevronDownIcon,
  ChevronUp as ChevronUpIcon,
  Plus as PlusIcon,
  ListMusic as QueueListIcon,
} from "lucide-react";
import { playlistArtUrl, type Playlist } from "../../api";
import { useTheme } from "../../context/Theme";
import { useScrollEdges } from "../../lib/useScrollEdges";
import CoverArt from "../CoverArt";
import NavItem from "./NavItem";

// Covers are drawn at 20px; ask for the smallest size the server makes.
const THUMB_SIZE = 64;

/**
 * The sidebar's playlists, scrolling without a scrollbar: one would take its
 * width from the collapsed rail and push the covers off centre. Like
 * ShelfScroller, the ends fade where there's more, and on hover arrows page
 * through.
 */
export default function SidebarPlaylists({
  playlists,
}: {
  /** Null until loaded: shows nothing rather than "None yet". */
  playlists: Playlist[] | null;
}) {
  const { layout } = useTheme();
  const { ref, edges, measure, page } = useScrollEdges<HTMLDivElement>("y");
  return (
    <div
      className="sidebar-playlists-scroller"
      data-back={edges.back || undefined}
      data-forward={edges.forward || undefined}
    >
      <div ref={ref} className="sidebar-playlists" onScroll={measure}>
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
        {playlists?.length === 0 && (
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
        {playlists?.map((p) => (
          <NavLink
            key={p.id}
            to={`/playlists/${p.id}`}
            title={layout === "compact" ? p.name : undefined}
            data-tooltip-side="right"
            className={({ isActive }) =>
              "sidebar-playlist" + (isActive ? " active" : "")
            }
          >
            <CoverArt
              className="sidebar-playlist-art"
              src={playlistArtUrl(p, THUMB_SIZE)}
              label={p.name}
            />
            <span className="sidebar-playlist-name">{p.name}</span>
          </NavLink>
        ))}
      </div>
      {/* Pointer shortcuts only: tabbing brings each playlist into view. */}
      <button
        type="button"
        className="sidebar-scroll-arrow sidebar-scroll-arrow-up"
        tabIndex={-1}
        aria-hidden="true"
        disabled={!edges.back}
        onClick={() => page(-1)}
      >
        <ChevronUpIcon className="size-3.5" />
      </button>
      <button
        type="button"
        className="sidebar-scroll-arrow sidebar-scroll-arrow-down"
        tabIndex={-1}
        aria-hidden="true"
        disabled={!edges.forward}
        onClick={() => page(1)}
      >
        <ChevronDownIcon className="size-3.5" />
      </button>
    </div>
  );
}
