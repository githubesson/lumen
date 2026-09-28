import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  SlidersHorizontal as AdjustmentsHorizontalIcon,
  Download as ArrowDownTrayIcon,
  LogOut as ArrowLeftEndOnRectangleIcon,
  Upload as ArrowUpTrayIcon,
  Clock as ClockIcon,
  Settings as Cog6ToothIcon,
  Disc3 as DiscIcon,
  Mail as EnvelopeIcon,
  Heart as HeartIcon,
  House as HomeIcon,
  Moon as MoonIcon,
  Music as MusicalNoteIcon,
  Radio as RadioIcon,
  Sparkles as SparklesIcon,
  Sun as SunIcon,
  UserRound as UserIcon,
} from "lucide-react";
import type { Playlist } from "../../api";
import { useAuth } from "../../context/Auth";
import { useTheme } from "../../context/Theme";
import { startDesktopDownload } from "../../lib/downloads";
import { isElectron } from "../../lib/platform";
import BrandMark from "../BrandMark";
import NavItem from "./NavItem";
import SidebarPlaylists from "./SidebarPlaylists";

type NavItemCfg = {
  label: string;
  to: string;
  icon: typeof HeartIcon;
};

type LibraryView = "tracks" | "albums" | "artists";

// Tracks, Albums and Artists are tabs of one /library page.
const BROWSE: (NavItemCfg & { view: LibraryView })[] = [
  { label: "Tracks", to: "/library", icon: MusicalNoteIcon, view: "tracks" },
  { label: "Albums", to: "/library?view=albums", icon: DiscIcon, view: "albums" },
  { label: "Artists", to: "/library?view=artists", icon: UserIcon, view: "artists" },
];

const VIEW_FOR_TYPE: Record<string, LibraryView> = {
  track: "tracks",
  album: "albums",
  artist: "artists",
};

/** Which Browse entry a /library URL belongs to; mirrors Library's own tab
 *  choice, with an open album or artist counting as its tab. */
function libraryViewOf(search: string): LibraryView {
  const params = new URLSearchParams(search);
  if (params.has("artist") || params.has("tidalArtist")) return "artists";
  if (params.has("album") || params.has("tidalAlbum")) return "albums";
  const view = params.get("view");
  if (view === "tracks" || view === "albums" || view === "artists") return view;
  return VIEW_FOR_TYPE[params.get("type") ?? ""] ?? "tracks";
}

const LIBRARY: NavItemCfg[] = [
  { label: "Favorites", to: "/favorites", icon: HeartIcon },
  { label: "Recent", to: "/recent", icon: ClockIcon },
  { label: "Replay", to: "/replay", icon: SparklesIcon },
];

export default function Sidebar({
  mobileOpen,
  playlists,
  pendingCount,
  fh6RadioEnabled,
  onAddMusic,
  onOpenTweaks,
}: {
  mobileOpen: boolean;
  /** Null until loaded. */
  playlists: Playlist[] | null;
  pendingCount: number;
  fh6RadioEnabled: boolean;
  onAddMusic: () => void;
  onOpenTweaks: () => void;
}) {
  const location = useLocation();
  const libraryView =
    location.pathname === "/library" ? libraryViewOf(location.search) : null;
  return (
    <aside
      id="app-sidebar"
      className={`sidebar${mobileOpen ? " mobile-open" : ""}`}
      aria-label="Sidebar"
    >
      <Link to="/" className="brand">
        <BrandMark />
        <div className="brand-text">
          <div className="brand-name">Lumen</div>
        </div>
      </Link>

      <div className="nav">
        <div className="nav-section-title">Browse</div>
        <NavItem
          to="/"
          icon={<HomeIcon className="nav-icon" />}
          label="Home"
          end
        />
        {BROWSE.map((i) => (
          <NavItem
            key={i.to}
            to={i.to}
            icon={<i.icon className="nav-icon" />}
            label={i.label}
            active={libraryView === i.view}
          />
        ))}
        {fh6RadioEnabled && (
          <NavItem
            to="/fh6-radio"
            icon={<RadioIcon className="nav-icon" />}
            label="Lumen Radio"
          />
        )}

        <div className="nav-section-title">Library</div>
        {LIBRARY.map((i) => (
          <NavItem
            key={i.to}
            to={i.to}
            icon={<i.icon className="nav-icon" />}
            label={i.label}
          />
        ))}
        {pendingCount > 0 && (
          <NavItem
            to="/invites"
            icon={<EnvelopeIcon className="nav-icon" />}
            label="Invites"
            badge={pendingCount}
          />
        )}
      </div>

      <SidebarPlaylists playlists={playlists} />

      <MobileSidebarActions
        onAddMusic={onAddMusic}
        onOpenTweaks={onOpenTweaks}
      />

      <SidebarFooter />
    </aside>
  );
}

function MobileSidebarActions({
  onAddMusic,
  onOpenTweaks,
}: {
  onAddMusic: () => void;
  onOpenTweaks: () => void;
}) {
  const { theme, toggle: toggleTheme } = useTheme();
  return (
    <div className="mobile-sidebar-actions" aria-label="Application actions">
      <button
        className="nav-item mobile-sidebar-action"
        type="button"
        onClick={onAddMusic}
      >
        <ArrowUpTrayIcon className="nav-icon" aria-hidden="true" />
        <span className="nav-label">Add music</span>
      </button>
      <button
        className="nav-item mobile-sidebar-action"
        type="button"
        onClick={toggleTheme}
      >
        {theme === "dark" ? (
          <SunIcon className="nav-icon" aria-hidden="true" />
        ) : (
          <MoonIcon className="nav-icon" aria-hidden="true" />
        )}
        <span className="nav-label">
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </span>
      </button>
      <button
        className="nav-item mobile-sidebar-action"
        type="button"
        data-settings-trigger=""
        onClick={onOpenTweaks}
      >
        <AdjustmentsHorizontalIcon className="nav-icon" aria-hidden="true" />
        <span className="nav-label">Settings</span>
      </button>
    </div>
  );
}

function SidebarFooter() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();

  const onLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  const initial = (me?.username ?? "?").slice(0, 2).toUpperCase();

  return (
    <div className="sidebar-footer">
      <div className="avatar">{initial}</div>
      <div className="user-text" style={{ flex: 1, minWidth: 0 }}>
        <div className="user-name">{me?.username}</div>
        <div className="user-plan">
          {me?.role === "admin" ? "admin" : "local library"}
        </div>
      </div>
      {me?.role === "admin" && (
        <NavLink
          to="/admin"
          className={({ isActive }) => "iconbtn" + (isActive ? " active" : "")}
          title="Admin"
          aria-label="Admin"
        >
          <Cog6ToothIcon className="size-4" />
        </NavLink>
      )}
      {!isElectron() && (
        <button
          className="iconbtn"
          title="Download desktop app"
          aria-label="Download desktop app"
          onClick={() => void startDesktopDownload()}
        >
          <ArrowDownTrayIcon className="size-4" />
        </button>
      )}
      <button
        className="iconbtn"
        title="Sign out"
        aria-label="Sign out"
        onClick={onLogout}
      >
        <ArrowLeftEndOnRectangleIcon className="size-4" />
      </button>
    </div>
  );
}
