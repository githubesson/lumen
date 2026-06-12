import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  AdjustmentsHorizontalIcon,
  ArrowLeftEndOnRectangleIcon,
  ArrowUpTrayIcon,
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
  ChevronRightIcon,
  ClockIcon,
  Cog6ToothIcon,
  EnvelopeIcon,
  HeartIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  MusicalNoteIcon,
  PlusIcon,
  QueueListIcon,
  RadioIcon,
  ServerStackIcon,
  SparklesIcon,
  SunIcon,
} from "@heroicons/react/16/solid";
import { api, type Playlist } from "../api";
import { useAuth } from "../context/Auth";
import { useTheme } from "../context/Theme";
import { useKey } from "../lib/keybindings";
import { useDiscordPresence } from "../lib/discordPresence";
import { swatchFor } from "../lib/swatch";
import { electron, getDesktopConfig, isElectron } from "../lib/platform";
import MiniPlayer from "./MiniPlayer";
import UploadDialog from "./UploadDialog";
import TweaksPanel from "./TweaksPanel";
import WindowControls from "./WindowControls";

const CommandPalette = lazy(() => import("./CommandPalette"));

type NavItemCfg = {
  label: string;
  to: string;
  icon: typeof QueueListIcon;
};

const BROWSE: NavItemCfg[] = [{ label: "Tracks", to: "/library", icon: QueueListIcon }];

const LIBRARY: NavItemCfg[] = [
  { label: "Favorites", to: "/favorites", icon: HeartIcon },
  { label: "Recent", to: "/recent", icon: ClockIcon },
  { label: "Replay", to: "/replay", icon: SparklesIcon },
];

export default function Shell() {
  const { me, logout } = useAuth();
  const { theme, toggle: toggleTheme, layout, setLayout } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [fh6RadioEnabled, setFh6RadioEnabled] = useState(false);

  useDiscordPresence();

  useEffect(() => {
    if (!me || me.must_reset_password) return;
    void api.listPlaylists().then((p) => setPlaylists(p ?? [])).catch(() => {});
    void api
      .listPendingInvites()
      .then((p) => setPendingCount(p?.length ?? 0))
      .catch(() => {});
    // must_reset_password is a dep: ForceReset lives inside this persistent
    // Shell, so the false→true→false flip with the same user id must re-run
    // this, otherwise the sidebar stays empty after a forced reset.
  }, [me?.id, me?.must_reset_password]);

  useEffect(() => {
    if (!isElectron) return;
    void getDesktopConfig()
      ?.then((cfg) => setFh6RadioEnabled(cfg.fh6RadioEnabled === true))
      .catch(() => setFh6RadioEnabled(false));
  }, []);

  const onLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  const crumbs = useMemo(
    () => buildCrumbs(location.pathname, params, playlists),
    [location.pathname, params, playlists],
  );

  const lastExpandedRef = useRef<"sidebar" | "wide">(
    layout === "wide" ? "wide" : "sidebar",
  );
  useEffect(() => {
    if (layout === "sidebar" || layout === "wide") {
      lastExpandedRef.current = layout;
    }
  }, [layout]);
  const toggleSidebar = () =>
    setLayout(layout === "compact" ? lastExpandedRef.current : "compact");

  useKey(
    "mod+k",
    (e) => {
      e.preventDefault();
      setPaletteOpen((o) => !o);
    },
    { id: "palette:toggle", label: "Toggle command palette", group: "Navigation", allowInInput: true },
  );
  useKey(
    "ctrl+b",
    (e) => {
      e.preventDefault();
      toggleSidebar();
    },
    { id: "sidebar:toggle", label: "Toggle sidebar", group: "Navigation" },
  );

  const initial = (me?.username ?? "?").slice(0, 2).toUpperCase();

  return (
    <div className="app">
      {/* Sidebar */}
      <aside className="sidebar" aria-label="Sidebar">
        <Link to="/" className="brand">
          <div className="brand-mark">L</div>
          <div className="brand-text">
            <div className="brand-name">Lumen</div>
          </div>
        </Link>

        <div className="nav">
          <div className="nav-section-title">Browse</div>
          <NavItem to="/" icon={<MusicalNoteIcon className="nav-icon" />} label="Home" end />
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
              className="mono"
              style={{ padding: "4px 10px", fontSize: 10, color: "var(--fg-subtle)" }}
            >
              None yet
            </div>
          )}
          {playlists.map((p) => (
            <NavLink
              key={p.id}
              to={`/playlists/${p.id}`}
              className={({ isActive }) =>
                "sidebar-playlist" + (isActive ? " active" : "")
              }
            >
              <div
                className="sidebar-playlist-swatch"
                style={{ background: swatchFor(p.id) }}
                aria-hidden="true"
              />
              <span className="sidebar-playlist-name">{p.name}</span>
            </NavLink>
          ))}
        </div>

        <div className="sidebar-footer">
          <div className="avatar">{initial}</div>
          <div className="user-text" style={{ flex: 1, minWidth: 0 }}>
            <div className="user-name">{me?.username}</div>
            <div className="user-plan">{me?.role === "admin" ? "admin" : "local library"}</div>
          </div>
          <button
            className="iconbtn"
            title="Sign out"
            aria-label="Sign out"
            onClick={onLogout}
          >
            <ArrowLeftEndOnRectangleIcon className="size-4" />
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="main">
        <div className="topbar">
          <button
            type="button"
            className="iconbtn"
            onClick={toggleSidebar}
            aria-label={layout === "compact" ? "Expand sidebar" : "Collapse sidebar"}
            title={layout === "compact" ? "Expand sidebar" : "Collapse sidebar"}
          >
            {layout === "compact" ? (
              <ChevronDoubleRightIcon className="size-4" aria-hidden="true" />
            ) : (
              <ChevronDoubleLeftIcon className="size-4" aria-hidden="true" />
            )}
          </button>
          <div className="crumbs">
            {crumbs.map((c, i) => (
              <span key={`${c.label}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {i > 0 && <ChevronRightIcon className="size-3" aria-hidden="true" />}
                {c.current ? (
                  <b>{c.label}</b>
                ) : c.to ? (
                  <Link to={c.to}>{c.label}</Link>
                ) : (
                  <span>{c.label}</span>
                )}
              </span>
            ))}
          </div>

          <div className="topbar-spacer" />

          <button
            type="button"
            className="search"
            onClick={() => setPaletteOpen(true)}
            aria-label="Open command palette"
            style={{
              cursor: "pointer",
              textAlign: "left",
              font: "inherit",
            }}
          >
            <MagnifyingGlassIcon className="size-3.5" aria-hidden="true" />
            <span style={{ flex: 1, color: "var(--fg-subtle)", fontSize: 12.5 }}>
              Search library, albums, tracks…
            </span>
            <kbd>⌘K</kbd>
          </button>

          <button
            className="iconbtn"
            type="button"
            title="Add music"
            aria-label="Add music"
            onClick={() => setUploadOpen(true)}
          >
            <ArrowUpTrayIcon className="size-4" aria-hidden="true" />
          </button>

          <button
            className="iconbtn"
            type="button"
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label="Toggle theme"
            onClick={toggleTheme}
          >
            {theme === "dark" ? (
              <SunIcon className="size-4" aria-hidden="true" />
            ) : (
              <MoonIcon className="size-4" aria-hidden="true" />
            )}
          </button>

          <button
            className={"iconbtn" + (tweaksOpen ? " active" : "")}
            type="button"
            title="Tweaks"
            aria-label="Tweaks"
            data-tweaks-trigger=""
            onClick={() => setTweaksOpen((v) => !v)}
          >
            <AdjustmentsHorizontalIcon className="size-4" aria-hidden="true" />
          </button>

          {isElectron && (
            <button
              className="iconbtn"
              type="button"
              title="Change server URL"
              aria-label="Change server URL"
              onClick={() => void electron?.openSettings()}
            >
              <ServerStackIcon className="size-4" aria-hidden="true" />
            </button>
          )}

          <WindowControls />
        </div>

        <div className="content">
          <Outlet />
        </div>
      </main>

      {/* Player */}
      <MiniPlayer />

      <TweaksPanel open={tweaksOpen} onClose={() => setTweaksOpen(false)} />

      <UploadDialog
        open={uploadOpen}
        isAdmin={me?.role === "admin"}
        onClose={() => setUploadOpen(false)}
      />

      <Suspense fallback={null}>
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          playlists={playlists}
          pendingInvites={pendingCount}
          onOpenTweaks={() => {
            setPaletteOpen(false);
            setTweaksOpen(true);
          }}
          onOpenUpload={() => {
            setPaletteOpen(false);
            setUploadOpen(true);
          }}
        />
      </Suspense>
    </div>
  );
}

function NavItem({
  to,
  icon,
  label,
  end,
  badge,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  end?: boolean;
  badge?: number;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}
    >
      {icon}
      <span className="nav-label">{label}</span>
      {badge != null && <span className="nav-badge">{badge}</span>}
    </NavLink>
  );
}

function buildCrumbs(
  pathname: string,
  params: Record<string, string | undefined>,
  playlists: Playlist[],
): { label: string; to?: string; current?: boolean }[] {
  if (pathname === "/") return [{ label: "Home", current: true }];
  if (pathname.startsWith("/library")) {
    return [{ label: "Library", current: true }];
  }
  if (pathname.startsWith("/favorites")) {
    return [{ label: "Library", to: "/library" }, { label: "Favorites", current: true }];
  }
  if (pathname.startsWith("/recent")) {
    return [{ label: "Library", to: "/library" }, { label: "Recent", current: true }];
  }
  if (pathname.startsWith("/replay")) {
    return [{ label: "Library", to: "/library" }, { label: "Replay", current: true }];
  }
  if (pathname.startsWith("/fh6-radio")) {
    return [{ label: "Lumen Radio", current: true }];
  }
  if (pathname === "/playlists") {
    return [{ label: "Playlists", current: true }];
  }
  if (pathname === "/playlists/new") {
    return [
      { label: "Playlists", to: "/playlists" },
      { label: "New", current: true },
    ];
  }
  if (pathname.startsWith("/playlists/") && params.id) {
    const p = playlists.find((x) => x.id === params.id);
    return [
      { label: "Playlists", to: "/playlists" },
      { label: p?.name ?? "…", current: true },
    ];
  }
  if (pathname.startsWith("/invites")) {
    return [{ label: "Invites", current: true }];
  }
  if (pathname.startsWith("/admin")) {
    return [{ label: "Admin", current: true }];
  }
  if (pathname.startsWith("/reset-password")) {
    return [{ label: "Reset password", current: true }];
  }
  return [{ label: "Home", current: true }];
}
