import {
  SlidersHorizontal as AdjustmentsHorizontalIcon,
  Upload as ArrowUpTrayIcon,
  Menu as Bars3Icon,
  MicVocal as BookOpenIcon,
  PanelLeftClose as ChevronDoubleLeftIcon,
  PanelLeftOpen as ChevronDoubleRightIcon,
  Search as MagnifyingGlassIcon,
  Moon as MoonIcon,
  Server as ServerStackIcon,
  Sun as SunIcon,
  X as XMarkIcon,
} from "lucide-react";
import type { Playlist } from "../../api";
import { useLyricsPanel } from "../../context/LyricsPanel";
import { useTheme } from "../../context/Theme";
import { electron, isElectron } from "../../lib/platform";
import WindowControls from "../WindowControls";
import Breadcrumbs from "./Breadcrumbs";

export default function Topbar({
  playlists,
  mobileNavOpen,
  tweaksOpen,
  onToggleMobileNav,
  onToggleSidebar,
  onOpenPalette,
  onOpenUpload,
  onToggleTweaks,
}: {
  playlists: Playlist[];
  mobileNavOpen: boolean;
  tweaksOpen: boolean;
  onToggleMobileNav: () => void;
  onToggleSidebar: () => void;
  onOpenPalette: () => void;
  onOpenUpload: () => void;
  onToggleTweaks: () => void;
}) {
  const { theme, toggle: toggleTheme, layout } = useTheme();
  const { open: lyricsOpen, toggle: toggleLyrics } = useLyricsPanel();

  return (
    <div className="topbar">
      <button
        type="button"
        className="iconbtn sidebar-toggle-mobile"
        onClick={onToggleMobileNav}
        aria-controls="app-sidebar"
        aria-expanded={mobileNavOpen}
        aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
        title={mobileNavOpen ? "Close navigation" : "Open navigation"}
      >
        {mobileNavOpen ? (
          <XMarkIcon className="size-4" aria-hidden="true" />
        ) : (
          <Bars3Icon className="size-4" aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        className="iconbtn sidebar-toggle-desktop"
        onClick={onToggleSidebar}
        aria-label={
          layout === "compact" ? "Expand sidebar" : "Collapse sidebar"
        }
        title={layout === "compact" ? "Expand sidebar" : "Collapse sidebar"}
      >
        {layout === "compact" ? (
          <ChevronDoubleRightIcon className="size-4" aria-hidden="true" />
        ) : (
          <ChevronDoubleLeftIcon className="size-4" aria-hidden="true" />
        )}
      </button>
      <Breadcrumbs playlists={playlists} />

      <div className="topbar-spacer" />

      <button
        type="button"
        className="search topbar-search"
        onClick={onOpenPalette}
        aria-label="Open command palette"
        style={{
          cursor: "pointer",
          textAlign: "left",
          font: "inherit",
        }}
      >
        <MagnifyingGlassIcon className="size-3.5" aria-hidden="true" />
        <span className="topbar-search-label">
          Search library, albums, tracks…
        </span>
        <kbd>⌘K</kbd>
      </button>

      <button
        className={"iconbtn" + (lyricsOpen ? " active" : "")}
        type="button"
        title="Lyrics"
        aria-label="Toggle lyrics panel"
        aria-pressed={lyricsOpen}
        onClick={toggleLyrics}
      >
        <BookOpenIcon className="size-4" aria-hidden="true" />
      </button>

      <button
        className="iconbtn topbar-secondary"
        type="button"
        title="Add music"
        aria-label="Add music"
        onClick={onOpenUpload}
      >
        <ArrowUpTrayIcon className="size-4" aria-hidden="true" />
      </button>

      <button
        className="iconbtn topbar-secondary"
        type="button"
        title={
          theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
        }
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
        className={"iconbtn topbar-secondary" + (tweaksOpen ? " active" : "")}
        type="button"
        title="Settings"
        aria-label="Settings"
        data-settings-trigger=""
        onClick={onToggleTweaks}
      >
        <AdjustmentsHorizontalIcon className="size-4" aria-hidden="true" />
      </button>

      {isElectron() && (
        <button
          className="iconbtn topbar-secondary"
          type="button"
          title="Change server URL"
          aria-label="Change server URL"
          onClick={() => void electron()?.openSettings()}
        >
          <ServerStackIcon className="size-4" aria-hidden="true" />
        </button>
      )}

      <WindowControls />
    </div>
  );
}
