import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  api,
  fisherYatesWithAnchor,
  toQueueItem,
  useAuth,
  type Album,
  type Artist,
  type Playlist,
  type PlaylistTracks,
  type TrackListItem,
} from "@music-library/core";

import { useFavorite, useFavoriteActions } from "../context/favorites";
import {
  useCurrentTrack,
  usePlayerControls,
  usePlayerPlayback,
  usePlayerQueue,
} from "../context/player";
import {
  buildArtistsTemplate,
  buildLibraryTabs,
  buildQueueTemplate,
  buildSignedOutTemplate,
  buildTrackListTemplate,
  CARPLAY_TAB,
  decodeDestination,
  greetingFor,
  nowPlayingNavButton,
  pushedTemplateId,
  trackArtwork,
  type CarPlayDestination,
} from "../lib/carplay/templates";
import { downloadStore } from "../lib/downloads";
import {
  isTrackPlayableOffline,
  offlineStore,
  useIsOffline,
} from "../lib/offline-mode";
import { qk } from "../lib/query-keys";
import { QUERY_STALE_TIME } from "../lib/query-policy";
import {
  addCarPlayAlbumArtistListener,
  addCarPlayConnectListener,
  addCarPlayDisconnectListener,
  addCarPlayNowPlayingButtonListener,
  addCarPlaySelectListener,
  addCarPlayUpNextListener,
  carPlayListLimits,
  configureCarPlayNowPlaying,
  finishCarPlaySelection,
  isCarPlayAvailable,
  isCarPlayConnected,
  isCarPlayTabsSupported,
  pushCarPlayList,
  pushCarPlayNowPlaying,
  selectCarPlayTab,
  setCarPlayRootList,
  setCarPlayRootTabs,
  updateCarPlayList,
  type CarPlayListTemplate,
  type CarPlaySelectEvent,
} from "../modules/carplay";

/** Matches the phone's Recent list so both share one cache entry. */
const RECENT_LIMIT = 100;
/** Fetched in one page each; the head unit truncates well below these. */
const ALBUM_PAGE_LIMIT = 300;
const ARTIST_PAGE_LIMIT = 300;
/**
 * Track lists kept for in-place refresh. CarPlay owns the pushed stack and
 * gives us no pop callback, so entries are trimmed by age instead — a few more
 * than the stack can hold (5) covers the visible screens.
 */
const TRACKED_LIST_LIMIT = 8;

/** A track list on screen, kept so its rows can be rebuilt and replayed. */
type TrackedList = { title: string; tracks: TrackListItem[] };

function subscribeToCarPlayConnection(onChange: () => void) {
  const connect = addCarPlayConnectListener(onChange);
  const disconnect = addCarPlayDisconnectListener(onChange);
  return () => {
    connect.remove();
    disconnect.remove();
  };
}

/**
 * Whether a car scene is attached. Read as an external store rather than
 * mirrored into state: the scene can connect before this runtime exists, and
 * `useSyncExternalStore` re-reads the snapshot on subscribe, so a connection
 * that happened between render and effect can't be missed.
 *
 * The third argument is required — app.json sets web.output "static", so Expo
 * Router prerenders on the server.
 */
function useCarPlayConnected(): boolean {
  return useSyncExternalStore(
    subscribeToCarPlayConnection,
    isCarPlayConnected,
    isCarPlayConnected,
  );
}

/**
 * Drives the CarPlay templates from the app's library data. Renders nothing on
 * the phone; mounted once, inside the player and auth providers.
 *
 * Three rules shape everything here:
 *
 *  - The car scene can connect before this runtime exists (app launched from
 *    the car's home screen), so connection is read as current state rather
 *    than waited for as an `onConnect` event.
 *  - Installing the root resets the car's navigation stack, so it runs only on
 *    connect and on account change. Every later change — a new current track,
 *    a list that finished loading — goes through `updateList`, which leaves
 *    the driver where they are.
 *  - The four browse tabs are fetched as soon as a car is attached rather than
 *    on selection. A tab that fills in after the driver has already looked at
 *    it is the one thing worse than a tab that was slow to open.
 */
export function CarPlayBridge() {
  const queryClient = useQueryClient();
  const { status, me } = useAuth();
  const controls = usePlayerControls();
  const currentTrack = useCurrentTrack();
  const { queue, index } = usePlayerQueue();
  const { shuffle, repeat } = usePlayerPlayback();
  const connected = useCarPlayConnected();
  // Empty id disables the query: with no car attached this component must not
  // pull the favorites list into the phone's cache on its own.
  const favorited = useFavorite(connected ? (currentTrack?.id ?? "") : "");
  const { toggle: toggleFavorite } = useFavoriteActions();
  // Rows for tracks that can't play right now are dimmed rather than left to
  // fail silently in the car, so the offline edge has to rebuild them.
  const offline = useIsOffline();

  const userId = me?.id;
  const signedIn = status === "authed" && !!userId;
  const currentTrackId = currentTrack?.id ?? null;

  const limits = useMemo(() => carPlayListLimits(), []);
  /** Track lists reachable from a row tap: the tabs, plus what's been pushed. */
  const tabListsRef = useRef(new Map<string, TrackedList>());
  const pushedRef = useRef(new Map<string, TrackedList>());

  const enabled = connected && signedIn;
  const recent = useQuery({
    queryKey: qk.recent(userId),
    queryFn: ({ signal }) => api.listRecent(RECENT_LIMIT, { signal }),
    staleTime: QUERY_STALE_TIME.default,
    enabled,
  });
  const favorites = useQuery({
    queryKey: qk.favorites(userId),
    queryFn: ({ signal }) => api.listFavorites({ signal }),
    staleTime: QUERY_STALE_TIME.default,
    enabled,
  });
  const playlists = useQuery({
    queryKey: qk.playlists(userId),
    queryFn: ({ signal }) => api.listPlaylists({ signal }),
    staleTime: QUERY_STALE_TIME.default,
    enabled,
  });
  const albums = useQuery({
    queryKey: qk.carPlayAlbums(userId),
    queryFn: async ({ signal }) =>
      (await api.listAlbumsPage({ limit: ALBUM_PAGE_LIMIT, signal })).items,
    staleTime: QUERY_STALE_TIME.default,
    enabled,
  });

  /** Downloaded covers first: a car is exactly where the network isn't. */
  const coverFor = useCallback(
    (track: TrackListItem) =>
      downloadStore.coverUriFor(track.id) ?? trackArtwork(track),
    [],
  );

  /** Rebuilt when connectivity flips, which is what makes every list holding
   *  it re-dim the rows that can't play right now. */
  const isPlayable = useCallback(
    (trackId: string) => isTrackPlayableOffline(trackId),
    // `offline` is the input the predicate reads through the store rather than
    // a value it closes over, so the linter can't see the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [offline],
  );

  /** Every screen carries the jump back to now playing. */
  const navButton = useMemo(
    () => nowPlayingNavButton(currentTrack),
    [currentTrack],
  );

  // Read at render: the string only changes twice a day, so it compares equal
  // and doesn't churn the templates that hold it.
  const greeting = greetingFor(new Date());

  // Destructured rather than passed as query objects: React Query hands back a
  // fresh result object every render, which would rebuild — and re-push — all
  // five tabs on every unrelated state change.
  const recentTracks = recent.data;
  const favoriteTracks = favorites.data;
  const playlistRows = playlists.data;
  const albumRows = albums.data;
  const recentLoading = isLoading(recent);
  const favoritesLoading = isLoading(favorites);
  const playlistsLoading = isLoading(playlists);
  const albumsLoading = isLoading(albums);

  const tabs = useMemo(
    () =>
      buildLibraryTabs({
        limits,
        coverFor,
        greeting,
        currentTrack,
        currentTrackId,
        isPlayable,
        recent: { tracks: recentTracks, loading: recentLoading },
        favorites: { tracks: favoriteTracks, loading: favoritesLoading },
        playlists: { playlists: playlistRows, loading: playlistsLoading },
        albums: { albums: albumRows, loading: albumsLoading },
      }),
    [
      albumRows,
      albumsLoading,
      coverFor,
      currentTrack,
      currentTrackId,
      favoriteTracks,
      favoritesLoading,
      greeting,
      isPlayable,
      limits,
      playlistRows,
      playlistsLoading,
      recentTracks,
      recentLoading,
    ],
  );

  // The tab lists are also playable lists: tapping a row has to find the tracks
  // behind it, and Play/Shuffle have to find the whole list.
  useEffect(() => {
    tabListsRef.current.set(CARPLAY_TAB.recent, {
      title: "Recent",
      tracks: recentTracks ?? [],
    });
    tabListsRef.current.set(CARPLAY_TAB.favorites, {
      title: "Favorites",
      tracks: favoriteTracks ?? [],
    });
    // Home's only track shelf is the favorites one, so a cover tapped there
    // plays from favorites.
    tabListsRef.current.set(CARPLAY_TAB.home, {
      title: "Favorites",
      tracks: favoriteTracks ?? [],
    });
  }, [favoriteTracks, recentTracks]);

  // `installKey` changes only when the whole hierarchy must be rebuilt: a fresh
  // connection, or a different account whose lists must not leak across.
  const installKey = connected ? `${userId ?? ""}:${signedIn}` : null;
  const installedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (installKey === null) {
      installedKeyRef.current = null;
      return;
    }

    if (installedKeyRef.current !== installKey) {
      installedKeyRef.current = installKey;
      pushedRef.current.clear();
      void installRoot(signedIn, tabs);
      return;
    }

    if (!signedIn) return;
    for (const tab of tabs) void updateCarPlayList(tab);
  }, [installKey, signedIn, tabs]);

  // Move the playing indicator on lists the user already pushed, and re-dim
  // rows when connectivity changes, without disturbing the navigation stack.
  useEffect(() => {
    if (!connected) return;
    for (const [id, list] of pushedRef.current) {
      void updateCarPlayList(
        buildTrackListTemplate({
          id,
          title: list.title,
          limits,
          coverFor,
          tracks: list.tracks,
          currentTrackId,
          isPlayable,
          navButton,
        }),
      );
    }
  }, [connected, coverFor, currentTrackId, isPlayable, limits, navButton]);

  // What the now-playing screen shows about itself: shuffle and repeat light
  // up when they're on, the heart matches the phone, and the two system
  // buttons only offer what there is to reach.
  useEffect(() => {
    if (!connected) return;
    void configureCarPlayNowPlaying({
      buttons: [
        { id: "shuffle", symbol: "shuffle", selected: shuffle },
        {
          id: "repeat",
          symbol: repeat === "one" ? "repeat.1" : "repeat",
          selected: repeat !== "off",
        },
        {
          id: "favorite",
          symbol: favorited ? "heart.fill" : "heart",
          selected: favorited,
          enabled: !!currentTrack,
        },
      ],
      upNextTitle: "Up Next",
      upNextEnabled: queue.length > index + 1,
      albumArtistEnabled: !!currentTrack?.album_id,
    });
  }, [connected, currentTrack, favorited, index, queue.length, repeat, shuffle]);

  const trackList = useCallback(
    (id: string, title: string, tracks: TrackListItem[] | undefined) => {
      if (tracks) {
        // Delete before set so re-visiting a list moves it to the end of the
        // Map's insertion order — the oldest entry is then also the one least
        // likely to still be on screen.
        pushedRef.current.delete(id);
        pushedRef.current.set(id, { title, tracks });
        for (const oldest of pushedRef.current.keys()) {
          if (pushedRef.current.size <= TRACKED_LIST_LIMIT) break;
          pushedRef.current.delete(oldest);
        }
      }
      return buildTrackListTemplate({
        id,
        title,
        limits,
        coverFor,
        tracks,
        currentTrackId,
        isPlayable,
        navButton,
      });
    },
    [coverFor, currentTrackId, isPlayable, limits, navButton],
  );

  const templateFor = useCallback(
    async (
      destination: CarPlayDestination,
    ): Promise<CarPlayListTemplate | null> => {
      const id = pushedTemplateId(destination);
      switch (destination.kind) {
        case "artists":
          return buildArtistsTemplate({
            limits,
            navButton,
            artists: await loadArtists(queryClient, userId),
          });
        case "playlist": {
          const tracks = await load<PlaylistTracks>(
            queryClient,
            qk.playlistTracks(userId, destination.id),
            ({ signal }) => api.listPlaylistTracks(destination.id, { signal }),
          );
          return trackList(
            id,
            playlistName(queryClient, userId, destination.id),
            tracks?.tracks.map(toQueueItem),
          );
        }
        case "album":
          return trackList(
            id,
            albumTitle(queryClient, userId, destination.id),
            await load(
              queryClient,
              qk.albumTracks(userId, destination.id),
              ({ signal }) => api.listAlbumTracks(destination.id, { signal }),
            ),
          );
        case "artist":
          return trackList(
            id,
            artistName(queryClient, userId, destination.id),
            await load(
              queryClient,
              qk.artistTracks(userId, destination.id),
              ({ signal }) => api.listArtistTracks(destination.id, { signal }),
            ),
          );
        default:
          return null;
      }
    },
    [limits, navButton, queryClient, trackList, userId],
  );

  const listFor = useCallback(
    (templateId: string) =>
      pushedRef.current.get(templateId) ?? tabListsRef.current.get(templateId),
    [],
  );

  const handleSelect = useCallback(
    async ({ selectionId, templateId, itemId }: CarPlaySelectEvent) => {
      // The row spins until the selection is finished, so every path — including
      // an unrecognised row or a failed fetch — has to reach the `finally`.
      try {
        const destination = decodeDestination(itemId);
        if (!destination) return;

        switch (destination.kind) {
          case "now-playing":
            await pushCarPlayNowPlaying();
            return;

          // A shelf's chevron, and the shelf row itself: the full list is
          // already a tab, so move there instead of pushing a second copy.
          case "recent":
          case "favorites":
          case "playlists":
          case "albums":
            await selectCarPlayTab(CARPLAY_TAB[destination.kind]);
            return;

          // A position in the live queue: move there rather than restarting the
          // queue, and stay on the list so the driver sees it advance.
          case "queued": {
            const position = Number(destination.id);
            if (Number.isInteger(position)) controls.jumpTo(position);
            return;
          }

          case "track": {
            const list = listFor(templateId);
            const track = list?.tracks.find(
              (candidate) => candidate.id === destination.id,
            );
            if (!track || !list) return;
            controls.play(track, list.tracks);
            await pushCarPlayNowPlaying();
            return;
          }

          // Play respects whatever shuffle mode is set, matching the phone.
          case "play-list": {
            const list = listFor(templateId);
            if (!list?.tracks.length) return;
            controls.play(list.tracks[0], list.tracks);
            await pushCarPlayNowPlaying();
            return;
          }

          // Shuffle turns the mode on and hands the player an already-shuffled
          // queue: `setShuffle` would otherwise reorder the queue this render
          // still thinks is playing, not the one we're about to start.
          case "shuffle-list": {
            const list = listFor(templateId);
            if (!list?.tracks.length) return;
            const shuffled = fisherYatesWithAnchor(list.tracks, null);
            if (!shuffle) controls.setShuffle(true);
            controls.play(shuffled[0], shuffled);
            await pushCarPlayNowPlaying();
            return;
          }

          default: {
            const template = await templateFor(destination);
            if (template) await pushCarPlayList(template);
          }
        }
      } finally {
        void finishCarPlaySelection(selectionId);
      }
    },
    [controls, listFor, shuffle, templateFor],
  );

  useEffect(() => {
    if (!isCarPlayAvailable()) return;
    const subscription = addCarPlaySelectListener((event) => {
      void handleSelect(event);
    });
    return () => {
      subscription.remove();
    };
  }, [handleSelect]);

  useEffect(() => {
    if (!isCarPlayAvailable()) return;

    const subscriptions = [
      addCarPlayNowPlayingButtonListener(({ buttonId }) => {
        if (buttonId === "shuffle") controls.toggleShuffle();
        if (buttonId === "repeat") controls.cycleRepeat();
        if (buttonId === "favorite" && currentTrack) {
          void toggleFavorite(currentTrack);
        }
      }),
      addCarPlayUpNextListener(() => {
        void pushCarPlayList(
          buildQueueTemplate({ limits, coverFor, queue, index }),
        );
      }),
      addCarPlayAlbumArtistListener(() => {
        const albumId = currentTrack?.album_id;
        if (!albumId) return;
        void templateFor({ kind: "album", id: albumId }).then((template) => {
          if (template) void pushCarPlayList(template);
        });
      }),
    ];

    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, [
    controls,
    coverFor,
    currentTrack,
    index,
    limits,
    queue,
    templateFor,
    toggleFavorite,
  ]);

  return null;
}

/**
 * Installs whichever root the running binary can show. Tabs need native code
 * newer than some installed builds; an older one still gets the Playing
 * screen, rather than sitting on the launch placeholder forever.
 */
function installRoot(signedIn: boolean, tabs: CarPlayListTemplate[]) {
  if (!signedIn) return setCarPlayRootList(buildSignedOutTemplate());
  if (!isCarPlayTabsSupported()) return setCarPlayRootList(tabs[0]);
  return setCarPlayRootTabs(tabs);
}

/** A tab is loading only while it has nothing to show; a background refresh
 *  must not replace a list the driver is reading with a spinner. */
function isLoading(query: { isFetching: boolean; data: unknown }): boolean {
  return query.isFetching && query.data === undefined;
}

/**
 * Read a list for the car: cache first when offline, otherwise fetch and fall
 * back to whatever is cached. Never rejects and never hangs — a pending fetch
 * would leave the row spinning until the native timeout releases it.
 *
 * `fetchQuery` is deliberate: these are the same keys the phone screens read,
 * so browsing in the car warms the app's own caches and vice versa.
 */
async function load<T>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  queryFn: (context: { signal: AbortSignal }) => Promise<T>,
): Promise<T | undefined> {
  const cached = queryClient.getQueryData<T>(queryKey);
  // React Query pauses fetches while offline, which would hang rather than
  // fail; the persisted cache is what the car runs on in that case.
  if (offlineStore.isOffline()) return cached;

  try {
    return await queryClient.fetchQuery({
      queryKey,
      queryFn,
      staleTime: QUERY_STALE_TIME.default,
      // One attempt: a retry can outlast the selection timeout.
      retry: false,
    });
  } catch {
    return cached;
  }
}

function loadArtists(queryClient: QueryClient, userId: string | undefined) {
  return load(
    queryClient,
    qk.carPlayArtists(userId),
    async ({ signal }) =>
      (await api.listArtistsPage({ limit: ARTIST_PAGE_LIMIT, signal })).items,
  );
}

/** Names come from the list the user navigated through, which is always cached
 *  by the time its rows can be tapped. */
function playlistName(
  queryClient: QueryClient,
  userId: string | undefined,
  id: string,
): string {
  const playlists = queryClient.getQueryData<Playlist[]>(qk.playlists(userId));
  return playlists?.find((playlist) => playlist.id === id)?.name ?? "Playlist";
}

function albumTitle(
  queryClient: QueryClient,
  userId: string | undefined,
  id: string,
): string {
  const albums = queryClient.getQueryData<Album[]>(qk.carPlayAlbums(userId));
  return albums?.find((album) => album.id === id)?.title ?? "Album";
}

function artistName(
  queryClient: QueryClient,
  userId: string | undefined,
  id: string,
): string {
  const artists = queryClient.getQueryData<Artist[]>(qk.carPlayArtists(userId));
  return artists?.find((artist) => artist.id === id)?.name ?? "Artist";
}
