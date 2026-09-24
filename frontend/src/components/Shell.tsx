import { Suspense, lazy, useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { api, type Playlist } from "../api";
import { useAuth } from "../context/Auth";
import { usePlaylists } from "../context/Playlists";
import { useKey } from "../lib/keybindings";
import { useDiscordPresence } from "../lib/discordPresence";
import { getDesktopConfig, isElectron } from "../lib/platform";
import { useLyricsPanel } from "../context/LyricsPanel";
import MiniPlayer from "./MiniPlayer";
import LyricsSidebar from "./LyricsSidebar";
import UploadDialog from "./UploadDialog";
import SettingsDialog from "./SettingsDialog";
import Sidebar from "./shell/Sidebar";
import Topbar from "./shell/Topbar";
import { useMobileNav } from "./shell/useMobileNav";
import { useSidebarToggle } from "./shell/useSidebarToggle";

const CommandPalette = lazy(() => import("./CommandPalette"));
const EMPTY_PLAYLISTS: Playlist[] = [];

export default function Shell() {
  const { me } = useAuth();
  const { open: lyricsOpen } = useLyricsPanel();
  const { data: playlistRows } = usePlaylists();
  const playlists = playlistRows ?? EMPTY_PLAYLISTS;
  const [pendingCount, setPendingCount] = useState(0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [fh6RadioEnabled, setFh6RadioEnabled] = useState(false);
  const { mobileNavOpen, setMobileNavOpen } = useMobileNav();

  useDiscordPresence();

  useEffect(() => {
    if (!me || me.must_reset_password) return;
    void api
      .listPendingInvites()
      .then((p) => setPendingCount(p?.length ?? 0))
      .catch(() => {});
    // must_reset_password is a dep: ForceReset lives inside this persistent
    // Shell, so the false→true→false flip with the same user id must re-run
    // this, otherwise the sidebar stays empty after a forced reset.
  }, [me?.id, me?.must_reset_password, me]);

  useEffect(() => {
    if (!isElectron()) return;
    void getDesktopConfig()
      ?.then((cfg) => setFh6RadioEnabled(cfg.fh6RadioEnabled === true))
      .catch(() => setFh6RadioEnabled(false));
  }, []);

  const toggleSidebar = useSidebarToggle();

  useKey(
    "mod+k",
    (e) => {
      e.preventDefault();
      // The palette layers below Settings; hand over instead of hiding behind it.
      setTweaksOpen(false);
      setPaletteOpen((o) => !o);
    },
    {
      id: "palette:toggle",
      allowInInput: true,
      // Settings hands over to the palette rather than blocking it.
      whileModal: true,
    },
  );
  useKey(
    "ctrl+b",
    (e) => {
      e.preventDefault();
      toggleSidebar();
    },
    { id: "sidebar:toggle" },
  );

  return (
    <div className="app" data-lyrics-open={lyricsOpen ? "true" : undefined}>
      {/* Sidebar */}
      <Sidebar
        mobileOpen={mobileNavOpen}
        playlists={playlists}
        pendingCount={pendingCount}
        fh6RadioEnabled={fh6RadioEnabled}
        onAddMusic={() => {
          setMobileNavOpen(false);
          setUploadOpen(true);
        }}
        onOpenTweaks={() => {
          setMobileNavOpen(false);
          setTweaksOpen(true);
        }}
      />
      <button
        type="button"
        className={`mobile-nav-backdrop${mobileNavOpen ? " visible" : ""}`}
        aria-label="Close navigation"
        aria-hidden={!mobileNavOpen}
        tabIndex={mobileNavOpen ? 0 : -1}
        onClick={() => setMobileNavOpen(false)}
      />

      {/* Main */}
      <main className="main">
        <Topbar
          playlists={playlists}
          mobileNavOpen={mobileNavOpen}
          tweaksOpen={tweaksOpen}
          onToggleMobileNav={() => setMobileNavOpen((open) => !open)}
          onToggleSidebar={toggleSidebar}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenUpload={() => setUploadOpen(true)}
          onToggleTweaks={() => setTweaksOpen((v) => !v)}
        />

        <div className="content">
          <Outlet />
        </div>
      </main>

      <LyricsSidebar />

      {/* Player */}
      <MiniPlayer />

      <SettingsDialog open={tweaksOpen} onClose={() => setTweaksOpen(false)} />

      <UploadDialog
        open={uploadOpen}
        isAdmin={me?.role === "admin"}
        onClose={() => setUploadOpen(false)}
      />

      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette
            open
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
      )}
    </div>
  );
}
