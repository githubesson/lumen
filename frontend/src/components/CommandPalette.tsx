import { useEffect, useMemo, useRef, useState } from "react";
import { Command } from "cmdk";
import { useNavigate } from "react-router-dom";
import {
  AdjustmentsHorizontalIcon,
  ArrowLeftEndOnRectangleIcon,
  ArrowPathRoundedSquareIcon,
  ArrowUpTrayIcon,
  ArrowsRightLeftIcon,
  BackwardIcon,
  ClockIcon,
  Cog6ToothIcon,
  EnvelopeIcon,
  ForwardIcon,
  HeartIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  MusicalNoteIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  QueueListIcon,
  SunIcon,
} from "@heroicons/react/16/solid";
import {
  albumCoverUrl,
  api,
  errorMessage,
  trackCoverUrl,
  type Album,
  type Artist,
  type Playlist,
  type TrackListItem,
} from "../api";
import CoverArt from "./CoverArt";
import { displayText } from "../lib/format";
import { useTrackContextMenu } from "./TrackContextMenu";
import { useAuth } from "../context/Auth";
import { usePlayer } from "../context/Player";
import { useTheme } from "../context/Theme";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  playlists: Playlist[];
  pendingInvites: number;
  onOpenTweaks: () => void;
  onOpenUpload: () => void;
}

export default function CommandPalette({
  open,
  onOpenChange,
  playlists,
  pendingInvites,
  onOpenTweaks,
  onOpenUpload,
}: Props) {
  const navigate = useNavigate();
  const { me, logout } = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();
  const {
    current,
    isPlaying,
    toggle,
    next,
    prev,
    toggleShuffle,
    cycleRepeat,
    play,
  } = usePlayer();

  const [query, setQuery] = useState("");
  const [tracks, setTracks] = useState<TrackListItem[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [artists, setArtists] = useState<Artist[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const reqId = useRef(0);

  // Reset query whenever the dialog opens so the user starts fresh.
  useEffect(() => {
    if (open) {
      setQuery("");
      setTracks([]);
      setAlbums([]);
      setArtists([]);
      setSearchError(null);
    }
  }, [open]);

  // Debounced library search — runs albums, artists, and tracks in parallel
  // so they stay in sync for a single keystroke. Albums and artists are
  // capped small since they surface above tracks and should stay scannable.
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2) {
      setTracks([]);
      setAlbums([]);
      setArtists([]);
      setSearchError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const id = ++reqId.current;
    const t = window.setTimeout(async () => {
      try {
        const [albumsPage, artistsPage, trackResult] = await Promise.all([
          api.listAlbumsPage({ q, limit: 8 }),
          api.listArtistsPage({ q, limit: 8 }),
          api.searchTracks({ q, limit: 20 }),
        ]);
        if (id !== reqId.current) return;
        setAlbums(albumsPage.items ?? []);
        setArtists(artistsPage.items ?? []);
        setTracks(trackResult.tracks ?? []);
        setSearchError(trackResult.warnings?.join(" ") || null);
        setLoading(false);
      } catch (err) {
        if (id === reqId.current) {
          setSearchError(errorMessage(err, "Search failed."));
          setLoading(false);
        }
      }
    }, 160);
    return () => window.clearTimeout(t);
  }, [query, open]);

  const close = () => onOpenChange(false);

  const run = (fn: () => void) => {
    fn();
    close();
  };

  const isAdmin = me?.role === "admin";
  const {
    bind: bindCtx,
    menu: trackCtxMenu,
    close: closeCtx,
    isOpen: isCtxOpen,
  } = useTrackContextMenu();

  const actions = useMemo(
    () =>
      [
        {
          id: "theme",
          label: theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
          keywords: "appearance theme dark light mode",
          icon: theme === "dark" ? SunIcon : MoonIcon,
          perform: toggleTheme,
        },
        {
          id: "tweaks",
          label: "Open tweaks",
          keywords: "settings depth radius density layout",
          icon: AdjustmentsHorizontalIcon,
          perform: onOpenTweaks,
        },
        {
          id: "upload",
          label: "Upload music",
          keywords: "add import ingest files",
          icon: ArrowUpTrayIcon,
          perform: onOpenUpload,
        },
        {
          id: "new-playlist",
          label: "New playlist",
          keywords: "create playlist",
          icon: PlusIcon,
          perform: () => navigate("/playlists/new"),
        },
        {
          id: "logout",
          label: "Sign out",
          keywords: "logout sign out",
          icon: ArrowLeftEndOnRectangleIcon,
          perform: async () => {
            await logout();
            navigate("/login", { replace: true });
          },
        },
      ].filter(Boolean),
    [theme, toggleTheme, onOpenTweaks, onOpenUpload, navigate, logout],
  );

  const playback = useMemo(
    () => [
      {
        id: "playpause",
        label: isPlaying ? "Pause" : "Play",
        keywords: "playback toggle",
        icon: isPlaying ? PauseIcon : PlayIcon,
        perform: toggle,
        disabled: !current,
      },
      {
        id: "next",
        label: "Next track",
        keywords: "skip forward",
        icon: ForwardIcon,
        perform: next,
        disabled: !current,
      },
      {
        id: "prev",
        label: "Previous track",
        keywords: "back prev",
        icon: BackwardIcon,
        perform: prev,
        disabled: !current,
      },
      {
        id: "shuffle",
        label: "Toggle shuffle",
        keywords: "random",
        icon: ArrowsRightLeftIcon,
        perform: toggleShuffle,
      },
      {
        id: "repeat",
        label: "Cycle repeat",
        keywords: "repeat loop",
        icon: ArrowPathRoundedSquareIcon,
        perform: cycleRepeat,
      },
    ],
    [isPlaying, current, toggle, next, prev, toggleShuffle, cycleRepeat],
  );

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(v) => {
        // When a right-click menu is open, Radix's dismissable-layer fires
        // close-intent for any click on the portaled menu (it sits outside
        // the dialog's content tree). Swallow that one dismissal and close
        // just the ctx menu — keep the palette itself up.
        if (!v && isCtxOpen) {
          closeCtx();
          return;
        }
        if (!v) closeCtx();
        onOpenChange(v);
      }}
      label="Command palette"
      shouldFilter={query.trim().length < 2}
      loop
    >
      <div className="cmdk-input-row">
        <MagnifyingGlassIcon className="size-4 shrink-0 text-subtle" />
        <Command.Input
          autoFocus
          value={query}
          onValueChange={setQuery}
          onKeyDown={(e) => {
            // While a library search is in flight, swallow Enter so the user
            // doesn't accidentally activate a stale highlight from the previous
            // query. cmdk processes Enter on capture, so stop it there too.
            if (e.key === "Enter" && loading) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          onKeyDownCapture={(e) => {
            if (e.key === "Enter" && loading) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          placeholder="Type a command or search tracks…"
        />
        <kbd className="cmdk-kbd">esc</kbd>
      </div>

      <Command.List className="cmdk-list">
          {loading && <Command.Loading>Searching…</Command.Loading>}
          {searchError ? (
            <div className="cmdk-empty" role="alert">
              {searchError}
            </div>
          ) : (
            <Command.Empty className="cmdk-empty">No results.</Command.Empty>
          )}

          {albums.length > 0 && (
            <Command.Group heading="Albums" className="cmdk-group">
              {albums.map((a) => (
                <Command.Item
                  key={`album-${a.id}`}
                  value={`album ${a.title} ${a.artist_name ?? ""}`}
                  onSelect={() =>
                    run(() =>
                      navigate(
                        `/library?view=albums&album=${encodeURIComponent(a.id)}`,
                      ),
                    )
                  }
                >
                  <CoverArt
                    className="cmdk-art"
                    src={a.has_cover ? albumCoverUrl(a.id) : null}
                    seed={a.id}
                    label={a.title}
                    forcePlaceholder={!a.has_cover}
                  />
                  <span className="cmdk-item-main">
                    <span className="cmdk-item-title">{a.title}</span>
                    <span className="cmdk-item-sub">
                      {a.artist_name ||
                        (a.is_compilation ? "Various Artists" : "Unknown artist")}
                      {" · "}
                      {a.track_count} {a.track_count === 1 ? "track" : "tracks"}
                    </span>
                  </span>
                  <span className="cmdk-shortcut">open</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          {artists.length > 0 && (
            <Command.Group heading="Artists" className="cmdk-group">
              {artists.map((a) => (
                <Command.Item
                  key={`artist-${a.id}`}
                  value={`artist ${a.name}`}
                  onSelect={() =>
                    run(() =>
                      navigate(
                        `/library?view=artists&artist=${encodeURIComponent(a.id)}`,
                      ),
                    )
                  }
                >
                  <CoverArt
                    className="cmdk-art"
                    seed={a.id}
                    label={a.name}
                    radius={999}
                    forcePlaceholder
                  />
                  <span className="cmdk-item-main">
                    <span className="cmdk-item-title">{a.name}</span>
                    <span className="cmdk-item-sub">
                      {a.track_count} {a.track_count === 1 ? "track" : "tracks"}
                      {a.album_count > 0 && (
                        <>
                          {" · "}
                          {a.album_count}{" "}
                          {a.album_count === 1 ? "album" : "albums"}
                        </>
                      )}
                    </span>
                  </span>
                  <span className="cmdk-shortcut">open</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          {tracks.length > 0 && (
            <Command.Group heading="Tracks" className="cmdk-group">
              {tracks.map((t) => (
                <Command.Item
                  key={`track-${t.id}`}
                  value={`track ${t.title} ${t.artist ?? ""} ${t.album_title ?? ""}`}
                  onSelect={() =>
                    run(() => play(t, tracks))
                  }
                  onContextMenu={bindCtx(t, { queue: tracks })}
                >
                  <CoverArt
                    className="cmdk-art"
                    src={trackCoverUrl(t)}
                    seed={t.album_id ?? t.id}
                    label={t.album_title || t.title}
                  />
                  <span className="cmdk-item-main">
                    <span className="cmdk-item-title">{displayText(t.title)}</span>
                    <span className="cmdk-item-sub">
                      {displayText(t.artist, "Unknown artist")}
                      {t.album_title ? ` · ${displayText(t.album_title)}` : ""}
                      {t.source === "tidal" ? " · TIDAL" : ""}
                    </span>
                  </span>
                  <span className="cmdk-shortcut">play</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          <Command.Group heading="Navigate" className="cmdk-group">
            <NavItem icon={MusicalNoteIcon} label="Home" hint="/" onSelect={() => run(() => navigate("/"))} />
            <NavItem icon={QueueListIcon} label="Library" hint="/library" onSelect={() => run(() => navigate("/library"))} />
            <NavItem icon={HeartIcon} label="Favorites" hint="/favorites" onSelect={() => run(() => navigate("/favorites"))} />
            <NavItem icon={ClockIcon} label="Recent" hint="/recent" onSelect={() => run(() => navigate("/recent"))} />
            <NavItem icon={QueueListIcon} label="Playlists" hint="/playlists" onSelect={() => run(() => navigate("/playlists"))} />
            {pendingInvites > 0 && (
              <NavItem
                icon={EnvelopeIcon}
                label="Pending invites"
                hint={`${pendingInvites}`}
                onSelect={() => run(() => navigate("/invites"))}
              />
            )}
            {isAdmin && (
              <NavItem
                icon={Cog6ToothIcon}
                label="Admin"
                hint="/admin"
                onSelect={() => run(() => navigate("/admin"))}
              />
            )}
          </Command.Group>

          {playlists.length > 0 && (
            <Command.Group heading="Playlists" className="cmdk-group">
              {playlists.map((p) => (
                <Command.Item
                  key={`pl-${p.id}`}
                  value={`playlist ${p.name}`}
                  onSelect={() => run(() => navigate(`/playlists/${p.id}`))}
                >
                  <QueueListIcon className="size-4 shrink-0 text-muted" />
                  <span className="cmdk-item-main">
                    <span className="cmdk-item-title">{p.name}</span>
                    <span className="cmdk-item-sub">
                      {p.visibility === "collaborative"
                        ? "collaborative"
                        : "private"}
                    </span>
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          <Command.Group heading="Playback" className="cmdk-group">
            {playback.map((a) => (
              <Command.Item
                key={a.id}
                value={`playback ${a.label} ${a.keywords}`}
                onSelect={() => !a.disabled && run(a.perform)}
                disabled={a.disabled}
              >
                <a.icon className="size-4 shrink-0 text-muted" />
                <span className="cmdk-item-main">
                  <span className="cmdk-item-title">{a.label}</span>
                </span>
              </Command.Item>
            ))}
          </Command.Group>

          <Command.Group heading="Actions" className="cmdk-group">
            {actions.map((a) => (
              <Command.Item
                key={a.id}
                value={`action ${a.label} ${a.keywords}`}
                onSelect={() => run(a.perform)}
              >
                <a.icon className="size-4 shrink-0 text-muted" />
                <span className="cmdk-item-main">
                  <span className="cmdk-item-title">{a.label}</span>
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>

      <div className="cmdk-footer">
        <span className="mono">
          <kbd className="cmdk-kbd">↵</kbd> to select
        </span>
        <span className="mono">
          <kbd className="cmdk-kbd">↑</kbd>
          <kbd className="cmdk-kbd">↓</kbd> to navigate
        </span>
        <span style={{ flex: 1 }} />
        <span className="mono">Lumen</span>
      </div>
      {trackCtxMenu}
    </Command.Dialog>
  );
}

function NavItem({
  icon: Icon,
  label,
  hint,
  onSelect,
}: {
  icon: typeof MusicalNoteIcon;
  label: string;
  hint?: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item value={`navigate ${label}`} onSelect={onSelect}>
      <Icon className="size-4 shrink-0 text-muted" />
      <span className="cmdk-item-main">
        <span className="cmdk-item-title">{label}</span>
      </span>
      {hint && <span className="cmdk-shortcut">{hint}</span>}
    </Command.Item>
  );
}
