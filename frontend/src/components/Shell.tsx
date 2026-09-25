import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { api, type Playlist } from "../api";
import { useAuth } from "../context/Auth";
import { usePlaylists } from "../context/Playlists";
import { useKey } from "../lib/keybindings";
import { useDiscordPresence } from "../lib/discordPresence";
import { useDesktopConfig } from "../lib/desktopConfig";
import { useLyricsPanel } from "../context/LyricsPanel";
import MiniPlayer from "./MiniPlayer";
import LyricsSidebar from "./LyricsSidebar";
import UploadDialog from "./UploadDialog";
import SettingsDialog, { type SectionId } from "./SettingsDialog";
import Sidebar from "./shell/Sidebar";
import Topbar from "./shell/Topbar";
import { OpenSettingsContext } from "./shell/openSettings";
import { useMobileNav } from "./shell/useMobileNav";
import { useSidebarToggle } from "./shell/useSidebarToggle";
import { claimResourceCache, clearResourceCache } from "../lib/resourceCache";

const CommandPalette = lazy(() => import("./CommandPalette"));
const EMPTY_PLAYLISTS: Playlist[] = [];

// The last pending-invite count, so the sidebar's Invites row is there from
// the first frame instead of pushing the nav down when the request lands.
const pendingKey = (userId: string) => `lumen.pendingInvites.${userId}`;
function readPendingCount(userId: string | undefined) {
  if (!userId) return 0;
  try {
    return Number(localStorage.getItem(pendingKey(userId))) || 0;
  } catch {
    return 0;
  }
}

export default function Shell() {
  const { me } = useAuth();
  claimResourceCache(me?.id ?? null);
  const { open: lyricsOpen } = useLyricsPanel();
  const { data: playlistRows } = usePlaylists();
  const playlists = playlistRows ?? EMPTY_PLAYLISTS;
  const [pendingCount, setPendingCount] = useState(() => readPendingCount(me?.id));
  const [uploadOpen, setUploadOpen] = useState(false);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SectionId>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const fh6RadioEnabled = useDesktopConfig()?.fh6RadioEnabled === true;
  const { mobileNavOpen, setMobileNavOpen } = useMobileNav();

  useDiscordPresence();

  // Pages cache their last results for revisits. Nothing is kept once the
  // signed-in shell goes (sign-out); a switch to another account is handled
  // by the claim above, before its pages render.
  useEffect(() => () => clearResourceCache(), []);

  useEffect(() => {
    if (!me || me.must_reset_password) return;
    const userId = me.id;
    void api
      .listPendingInvites()
      .then((p) => {
        const count = p?.length ?? 0;
        setPendingCount(count);
        try {
          localStorage.setItem(pendingKey(userId), String(count));
        } catch {
          // Only costs the head start on the next launch.
        }
      })
      .catch(() => {});
    // must_reset_password is a dep: ForceReset lives inside this persistent
    // Shell, so the false→true→false flip with the same user id must re-run
    // this, otherwise the sidebar stays empty after a forced reset.
  }, [me?.id, me?.must_reset_password, me]);

  const openSettings = useCallback((section?: SectionId) => {
    setSettingsSection(section);
    setTweaksOpen(true);
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
        playlists={playlistRows}
        pendingCount={pendingCount}
        fh6RadioEnabled={fh6RadioEnabled}
        onAddMusic={() => {
          setMobileNavOpen(false);
          setUploadOpen(true);
        }}
        onOpenTweaks={() => {
          setMobileNavOpen(false);
          openSettings();
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
          onToggleTweaks={() => {
            setSettingsSection(undefined);
            setTweaksOpen((v) => !v);
          }}
        />

        <div className="content">
          <OpenSettingsContext.Provider value={openSettings}>
            <Outlet />
          </OpenSettingsContext.Provider>
        </div>
      </main>

      <LyricsSidebar />

      {/* Player */}
      <MiniPlayer />

      <SettingsDialog
        open={tweaksOpen}
        section={settingsSection}
        onClose={() => setTweaksOpen(false)}
      />

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
              openSettings();
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
