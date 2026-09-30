import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { Outlet } from "react-router-dom";
import { api, type Playlist } from "../api";
import { useAuth } from "../context/Auth";
import { usePlaylists } from "../context/Playlists";
import { useKey } from "../lib/keybindings";
import { useDesktopConfig } from "../lib/desktopConfig";
import { useLyricsPanel } from "../context/LyricsPanel";
import MiniPlayer from "./MiniPlayer";
import LyricsSidebar from "./LyricsSidebar";
import { isElectron } from "../lib/platform";

import type { SectionId } from "./SettingsDialog";
import Sidebar from "./shell/Sidebar";
import Topbar from "./shell/Topbar";
import { OpenSettingsContext } from "./shell/openSettings";
import { useMobileNav } from "./shell/useMobileNav";
import { useSidebarToggle } from "./shell/useSidebarToggle";
import { claimResourceCache, clearResourceCache } from "../lib/resourceCache";
import { openWhenLoaded, type LazyChunk } from "../lib/lazyChunk";
import {
  CommandPalette,
  commandPaletteChunk,
  SettingsDialog,
  settingsDialogChunk,
  UploadDialog,
  uploadDialogChunk,
} from "./lazyDialogs";

const UpdateToast = lazy(() => import("./UpdateToast"));
// Desktop-only, so the web build never downloads it.
const DiscordPresence = lazy(() => import("../lib/discordPresence"));
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

  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [uploadLoaded, setUploadLoaded] = useState(false);

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

  // Dialogs load on first open. One pending open per dialog: a newer
  // request replaces it, and a dismissal while its chunk loads cancels it.
  const pendingOpens = useRef<Record<string, () => void>>({});
  const openLazy = useCallback((key: string, chunk: LazyChunk<unknown>, commit: () => void) => {
    pendingOpens.current[key]?.();
    pendingOpens.current[key] = openWhenLoaded(chunk, commit);
  }, []);
  useEffect(() => {
    const pending = pendingOpens.current;
    return () => Object.values(pending).forEach((cancel) => cancel());
  }, []);
  // Settings and Upload are small: fetch them once the page is idle so a
  // first open is instant.
  useEffect(() => {
    const preload = () => {
      void settingsDialogChunk.load().catch(() => {});
      void uploadDialogChunk.load().catch(() => {});
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(preload, { timeout: 5000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = window.setTimeout(preload, 3000);
    return () => window.clearTimeout(timer);
  }, []);

  const openSettings = useCallback((section?: SectionId) => {
    openLazy("settings", settingsDialogChunk, () => {
      setSettingsLoaded(true);
      setSettingsSection(section);
      setTweaksOpen(true);
    });
  }, [openLazy]);
  const openUpload = useCallback(() => {
    openLazy("upload", uploadDialogChunk, () => {
      setUploadLoaded(true);
      setUploadOpen(true);
    });
  }, [openLazy]);
  const openPalette = useCallback(() => {
    openLazy("palette", commandPaletteChunk, () => setPaletteOpen(true));
  }, [openLazy]);

  const toggleSidebar = useSidebarToggle();

  useKey(
    "mod+k",
    (e) => {
      e.preventDefault();
      // The palette layers below Settings; hand over instead of hiding behind it.
      setTweaksOpen(false);
      if (paletteOpen) setPaletteOpen(false);
      else openPalette();
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
          openUpload();
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
          onOpenPalette={openPalette}
          onOpenUpload={openUpload}
          onToggleTweaks={() => {
            if (tweaksOpen) setTweaksOpen(false);
            else openSettings();
          }}
        />

        <div className="content">
          <OpenSettingsContext.Provider value={openSettings}>
            <Outlet />
          </OpenSettingsContext.Provider>
        </div>

        {/* Update prompts only exist in the desktop app. */}
        {isElectron() && <Suspense fallback={null}><UpdateToast /></Suspense>}
      </main>

      <LyricsSidebar />

      {/* Player */}
      <MiniPlayer />

      {isElectron() && <Suspense fallback={null}><DiscordPresence /></Suspense>}
      <Suspense fallback={null}>
        {settingsLoaded && <SettingsDialog
          open={tweaksOpen}
          section={settingsSection}
          onClose={() => setTweaksOpen(false)}
        />}

        {uploadLoaded && <UploadDialog
          open={uploadOpen}
          isAdmin={me?.role === "admin"}
          onClose={() => setUploadOpen(false)}
        />}
      </Suspense>

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
              openUpload();
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
