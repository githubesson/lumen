import { Link, useNavigate } from "react-router-dom";
import {
  SlidersHorizontal as AdjustmentsHorizontalIcon,
  Download as ArrowDownTrayIcon,
  LogOut as ArrowLeftEndOnRectangleIcon,
  Upload as ArrowUpTrayIcon,
  Clock as ClockIcon,
  Settings as Cog6ToothIcon,
  Mail as EnvelopeIcon,
  Heart as HeartIcon,
  Moon as MoonIcon,
  Music as MusicalNoteIcon,
  ListMusic as QueueListIcon,
  Radio as RadioIcon,
  Server as ServerStackIcon,
  Sparkles as SparklesIcon,
  Sun as SunIcon,
} from "lucide-react";
import type { Playlist } from "../../api";
import { useAuth } from "../../context/Auth";
import { useTheme } from "../../context/Theme";
import { startDesktopDownload } from "../../lib/downloads";
import { electron, isElectron } from "../../lib/platform";
import NavItem from "./NavItem";
import SidebarPlaylists from "./SidebarPlaylists";

type NavItemCfg = {
  label: string;
  to: string;
  icon: typeof QueueListIcon;
};

const BROWSE: NavItemCfg[] = [
  { label: "Tracks", to: "/library", icon: QueueListIcon },
];

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
  playlists: Playlist[];
  pendingCount: number;
  fh6RadioEnabled: boolean;
  onAddMusic: () => void;
  onOpenTweaks: () => void;
}) {
  const { me } = useAuth();
  return (
    <aside
      id="app-sidebar"
      className={`sidebar${mobileOpen ? " mobile-open" : ""}`}
      aria-label="Sidebar"
    >
      <Link to="/" className="brand">
        <div className="brand-mark">L</div>
        <div className="brand-text">
          <div className="brand-name">Lumen</div>
        </div>
      </Link>

      <div className="nav">
        <div className="nav-section-title">Browse</div>
        <NavItem
          to="/"
          icon={<MusicalNoteIcon className="nav-icon" />}
          label="Home"
          end
        />
        {BROWSE.map((i) => (
          <NavItem
            key={i.to}
            to={i.to}
            icon={<i.icon className="nav-icon" />}
            label={i.label}
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
        {me?.role === "admin" && (
          <NavItem
            to="/admin"
            icon={<Cog6ToothIcon className="nav-icon" />}
            label="Admin"
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
        onClick={onOpenTweaks}
      >
        <AdjustmentsHorizontalIcon className="nav-icon" aria-hidden="true" />
        <span className="nav-label">Tweaks</span>
      </button>
      {isElectron() && (
        <button
          className="nav-item mobile-sidebar-action"
          type="button"
          onClick={() => void electron()?.openSettings()}
        >
          <ServerStackIcon className="nav-icon" aria-hidden="true" />
          <span className="nav-label">Server settings</span>
        </button>
      )}
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
