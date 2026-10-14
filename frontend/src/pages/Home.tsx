import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useSearchParams } from "react-router-dom";
import { LayoutDashboard as CustomizeIcon } from "lucide-react";
import { api, errorMessage, type ReplayData, type TrackListItem } from "../api";
import { Button } from "../components/Button";
import { BoardSlot, useBoardEditor } from "../components/home/BoardEditing";
import { boardLayout, packedLayout, type BoardCell } from "../components/home/boardLayout";
import {
  CUSTOMIZE_PARAM,
  DEFAULT_PANEL_IDS,
  arrangementTweak,
  defaultSlots,
  readArrangement,
  type HomePanel,
  type HomePanelId,
} from "../components/home/homeArrangement";
import { homeAlbums } from "../components/home/homeAlbums";
import {
  A_ROW,
  HomePanelView,
  LIST_ROWS,
  replayError,
  replayRequest,
  type PanelContext,
  type SourceState,
} from "../components/home/HomePanels";
import { DEFAULT_PERIOD, PANEL_KINDS, type PanelKind } from "../components/home/panelKinds";
import { useTrackContextMenu } from "../lib/useTrackContextMenu";
import { useTheme } from "../context/Theme";
import { usePlayerControls } from "../context/Player";
import { useFavorites } from "../context/Favorites";
import { usePlaylists } from "../context/Playlists";
import { useApiResource, type ApiResource } from "../lib/useApiResource";
import { readCache } from "../lib/resourceCache";
import { REPLAY_YEARS_KEY, fetchReplay, readReplayCache, storeReplay } from "../lib/replayData";
import { displayText } from "../lib/format";
import { startListPlayback } from "@music-library/core/player/play-list";
import { playableTracks, playlistEntryToTrack } from "@music-library/core/track";
import { periodKey, type Period } from "@music-library/core/replay/period";

const EMPTY_TRACKS: TrackListItem[] = [];

// Recently played is asked for in steps of this many, enough to fill its
// panel; so is Recently added, from the newest tracks.
const RECENT_STEP = 20;
// The newest tracks, per six album covers: usually enough to find them.
const TRACKS_PER_SIX_ALBUMS = 80;
// The most tracks the server sends in one page.
const MAX_TRACKS = 500;

/** A source not loaded yet: its panels show placeholders until it reports. */
const UNKNOWN: SourceState<never> = { data: null, loading: true, error: null, reload: () => {} };
/** A deleted playlist's tracks: none, and none coming. */
const GONE: SourceState<TrackListItem[]> = { data: [], loading: false, error: null, reload: () => {} };

const replaySource = (period: Period | undefined) => `replay:${periodKey(period ?? DEFAULT_PERIOD)}`;
const playlistSource = (id: string | undefined) => `playlist:${id ?? ""}`;

/** What a panel has to show, from the source it draws on. */
interface Content {
  /** The source, so only the first panel on it shows its error. */
  source: string;
  count: number;
  /** The source has answered at least once. */
  known: boolean;
  loading: boolean;
  error: string | null;
}

export default function Home() {
  const { play } = usePlayerControls();
  const { homeBoard, setHomeBoard, tweaksLoaded } = useTheme();
  const arrangement = useMemo(() => readArrangement(homeBoard), [homeBoard]);
  const enabled = useMemo(() => arrangement.panels.filter((panel) => !panel.hidden), [arrangement]);

  // How many items the paged panels' rooms ask for, by panel.
  const [wants, setWants] = useState<Readonly<Record<HomePanelId, number>>>({});
  const want = useCallback(
    (id: HomePanelId, count: number | null) =>
      setWants((prev) => {
        if ((prev[id] ?? null) === count) return prev;
        const next = { ...prev };
        if (count === null) delete next[id];
        else next[id] = count;
        return next;
      }),
    [],
  );
  const wanted = (kind: PanelKind, usual: number) =>
    Math.max(usual, ...enabled.filter((panel) => panel.kind === kind).map((panel) => wants[panel.id] ?? usual));

  const recentLimit = Math.ceil(wanted("recent", LIST_ROWS) / RECENT_STEP) * RECENT_STEP;
  const recentSent = useRef(0);
  const recentResource = useApiResource(
    (signal) => {
      recentSent.current = recentLimit;
      return api.listRecent(recentLimit, { signal });
    },
    "Could not load recently played tracks.",
    { cacheKey: "home:recent" },
  );
  useReloadWhenLarger(recentResource.reload, recentLimit, recentSent);
  // The newest tracks: for the hero before anything is played, Albums and
  // Recently added.
  const trackLimit = Math.min(
    MAX_TRACKS,
    Math.max(
      TRACKS_PER_SIX_ALBUMS * Math.ceil(Math.max(wanted("albums", A_ROW(4)), 6) / 6),
      Math.ceil(wanted("added", LIST_ROWS) / RECENT_STEP) * RECENT_STEP,
    ),
  );
  const trackSent = useRef(0);
  const tracksResource = useApiResource(
    (signal) => {
      trackSent.current = trackLimit;
      return api.listTracks({ limit: trackLimit, signal });
    },
    "Could not load your library.",
    { cacheKey: "home:tracks" },
  );
  useReloadWhenLarger(tracksResource.reload, trackLimit, trackSent);
  const favorites = useFavorites();
  const playlistResource = usePlaylists();
  const { bind: bindCtx, menu: ctxMenu } = useTrackContextMenu();
  const { playFetched, failure } = useFetchAndPlay();

  // A Replay period's numbers and a playlist's tracks load once each,
  // however many panels draw on them, and only for panels on the board.
  const [sources, publish] = useSources();
  const periods = useMemo(() => {
    const out = new Map<string, Period>();
    for (const panel of enabled) if (PANEL_KINDS[panel.kind].period) out.set(replaySource(panel.period), panel.period ?? DEFAULT_PERIOD);
    return [...out];
  }, [enabled]);
  // Asked for once the user's playlists are known (the shell loads them
  // alongside Home), and only those still among them: a deleted one's
  // panel has nothing to show, not an error or its old tracks. If the list
  // can't be had, each is asked for anyway, to show its own state.
  // Latched, so retrying the list doesn't empty the panels meanwhile.
  const playlistData = playlistResource.data;
  const [listFailed, setListFailed] = useState(false);
  if (playlistData === null && !playlistResource.loading && !listFailed) setListFailed(true);
  const pinAll = playlistData === null && listFailed;
  const pinned = useMemo(
    () => [
      ...new Set(
        enabled.flatMap((panel) =>
          panel.kind === "playlist" && panel.playlist && (pinAll || playlistData?.some((p) => p.id === panel.playlist))
            ? [panel.playlist]
            : [],
        ),
      ),
    ],
    [enabled, playlistData, pinAll],
  );
  const replayOf = (period: Period | undefined) =>
    (sources[replaySource(period)] as ApiResource<ReplayData> | undefined) ?? UNKNOWN;
  const gone = (id: string | undefined) => !!playlistData && !playlistData.some((p) => p.id === id);
  const playlistOf = (id: string | undefined) =>
    gone(id) ? GONE : ((id ? (sources[playlistSource(id)] as ApiResource<TrackListItem[]> | undefined) : undefined) ?? UNKNOWN);

  const recent = recentResource.data ?? EMPTY_TRACKS;
  const tracks = tracksResource.data ?? EMPTY_TRACKS;
  const playlists = playlistData;
  const albums = useMemo(() => homeAlbums(tracks), [tracks]);

  // Wait for recently played before picking the hero, so a library track
  // doesn't take the slot and then get swapped out when it lands.
  const recentSettled = recentResource.data !== null || !recentResource.loading;
  const hero = recentSettled ? recent[0] ?? tracks[0] ?? null : null;

  const contentOf = (panel: HomePanel): Content | null => {
    switch (panel.kind) {
      case "resume":
        return null;
      case "repeat":
      case "artists":
      case "top-albums":
      case "stats":
      case "genres":
      case "activity": {
        const source = replayOf(panel.period);
        const data = source.data;
        const count =
          !data || data.summary.total_plays === 0
            ? 0
            : panel.kind === "repeat"
              ? data.top_tracks.length
              : panel.kind === "artists"
                ? data.top_artists.length
                : panel.kind === "top-albums"
                  ? data.top_albums.length
                  : panel.kind === "genres"
                    ? data.top_genres.length
                    : 1;
        return { source: replaySource(panel.period), count, known: data !== null, loading: source.loading, error: source.error };
      }
      case "recent":
        return { source: "recent", count: recent.length, known: recentResource.data !== null, loading: recentResource.loading, error: recentResource.error };
      case "favorites":
        return { source: "favorites", count: favorites.tracks.length, known: favorites.loaded, loading: favorites.loading, error: favorites.error };
      case "albums":
      case "added":
        return {
          source: "tracks",
          count: panel.kind === "albums" ? albums.length : tracks.length,
          known: tracksResource.data !== null,
          loading: tracksResource.loading,
          error: tracksResource.error,
        };
      case "playlists":
        return { source: "playlists", count: playlists?.length ?? 0, known: playlists !== null, loading: playlistResource.loading, error: playlistResource.error };
      case "playlist": {
        // One deleted since has nothing to show (see `playlistOf`).
        const source = playlistOf(panel.playlist);
        return {
          source: playlistSource(panel.playlist),
          count: source.data?.length ?? 0,
          known: source.data !== null,
          loading: source.loading,
          error: source.error,
        };
      }
    }
  };
  const contents = new Map(enabled.map((panel) => [panel.id, contentOf(panel)]));
  // A source's load state shows once, in the first panel drawing on it that
  // has something to show (On repeat's, for Top artists), or the first at
  // all when none has yet.
  const owners = new Set<HomePanelId>();
  const bySource = new Map<string, HomePanelId[]>();
  for (const panel of enabled) {
    const content = contents.get(panel.id);
    if (content) bySource.set(content.source, [...(bySource.get(content.source) ?? []), panel.id]);
  }
  for (const ids of bySource.values()) owners.add(ids.find((id) => contents.get(id)!.count > 0) ?? ids[0]);

  // Until every list has settled once (arrived or failed), the board keeps
  // its full shape, with placeholders where a list hasn't come in or came in
  // empty. Then it swaps to the panels that have something, in one change
  // rather than one per list. Latched, so a later retry or refresh doesn't
  // bring the placeholder board back.
  const answered = (resource: { data: unknown; loading: boolean } | undefined) =>
    !!resource && (resource.data !== null || !resource.loading);
  // Not before the desktop app has read the board, whose panels may draw
  // on sources the default one doesn't.
  const allSettled =
    tweaksLoaded &&
    answered(recentResource) &&
    answered(tracksResource) &&
    (favorites.loaded || !favorites.loading) &&
    answered(playlistResource) &&
    periods.every(([key]) => answered(sources[key])) &&
    pinned.every((id) => answered(sources[playlistSource(id)]));
  const [settled, setSettled] = useState(allSettled);
  if (allSettled && !settled) setSettled(true);
  /** Show placeholders: nothing to list yet, and no error to show instead. */
  const pending = (count: number, loading: boolean, error: string | null) =>
    count === 0 && !error && (!settled || loading);

  // Once settled, a panel shows while it has something, or to offer a retry.
  // One whose list is unknown and loading again (a retry) stays as it was
  // until real data arrives: the panel whose Retry was pressed keeps its
  // place, with placeholders, and one already gone (Top artists, when On
  // repeat failed) doesn't come back as placeholders only to vanish again
  // if the retry fails. A list known to be empty stays hidden while it
  // revalidates, so revisits don't flash it and reflow the board.
  const [shown, setShown] = useState<readonly HomePanelId[]>(() => enabled.map((panel) => panel.id));
  const present = settled
    ? enabled
        .filter((panel) => {
          const content = contents.get(panel.id);
          if (!content) return true;
          const error = owners.has(panel.id) ? content.error : null;
          return content.count > 0 || !!error || (!content.known && content.loading && shown.includes(panel.id));
        })
        .map((panel) => panel.id)
    : enabled.map((panel) => panel.id);
  if (present.length !== shown.length || present.some((id, i) => id !== shown[i])) setShown(present);

  // While customizing, every panel that isn't hidden is on the board, empty
  // or not, so it can be moved.
  const [params, setParams] = useSearchParams();
  const editing = params.has(CUSTOMIZE_PARAM);
  const setEditing = (on: boolean) =>
    setParams(
      (p) => {
        if (on) p.set(CUSTOMIZE_PARAM, "");
        else p.delete(CUSTOMIZE_PARAM);
        return p;
      },
      { replace: true },
    );
  const hasContent = (panel: HomePanel) => present.includes(panel.id);
  const onBoard = (panel: HomePanel) => !panel.hidden && (editing || hasContent(panel));
  // The default board's slots, each holding the panel moved there, or the
  // panels packed by their own sizes.
  const slots = defaultSlots(arrangement);
  const layout = slots
    ? boardLayout(DEFAULT_PANEL_IDS.filter((_, i) => onBoard(slots[i])))
    : packedLayout(enabled.filter(onBoard).map(({ id, w, h }) => ({ id, w, h })));
  const byId = new Map(arrangement.panels.map((panel) => [panel.id, panel]));
  /** Why a panel is off the board outside customizing, for its tile. */
  const noteFor = (panel: HomePanel) =>
    panel.kind === "playlist" && gone(panel.playlist)
      ? playlistData!.length > 0
        ? "Its playlist was deleted. Pick another in Edit."
        : "Its playlist was deleted, and there's no other to pick."
      : !hasContent(panel) && settled
        ? "Shows up once it has something"
        : null;
  const panelIn = (cell: BoardCell) =>
    slots ? slots[DEFAULT_PANEL_IDS.indexOf(cell.id as (typeof DEFAULT_PANEL_IDS)[number])] : byId.get(cell.id)!;
  // The years a period panel can show: what any loaded period says has
  // plays, or what Replay last said.
  const years = useMemo(() => {
    const found = new Set<number>(readCache<number[]>(REPLAY_YEARS_KEY) ?? []);
    for (const [key] of periods) for (const year of (sources[key]?.data as ReplayData | null)?.available_years ?? []) found.add(year);
    return [...found].sort((a, b) => b - a);
  }, [periods, sources]);
  const editor = useBoardEditor({
    editing,
    arrangement,
    playlists,
    years,
    onChange: (next) => setHomeBoard(arrangementTweak(next)),
    onDone: () => setEditing(false),
  });

  const ctx: PanelContext = {
    play,
    bindCtx,
    playFetched,
    failure,
    pending,
    ownsSource: (id) => owners.has(id),
    want,
    recent: recentResource,
    tracks: tracksResource,
    albums,
    favorites,
    playlists: playlistResource,
    replay: replayOf,
    playlistTracks: playlistOf,
    hero,
  };

  const loaders = (
    <>
      {periods.map(([key, period]) => (
        <ReplaySource key={key} name={key} period={period} publish={publish} />
      ))}
      {pinned.map((id) => (
        <PlaylistSource key={id} id={id} publish={publish} />
      ))}
    </>
  );

  // The desktop app reads the arrangement from its config file; until then
  // the board would take the default shape and then jump.
  if (!tweaksLoaded) return <div className="view board-view" />;

  return (
    <div className="view board-view">
      {/* Only for the board the app has read: the default one's might not
          be the user's. */}
      {loaders}
      {ctxMenu}
      {editing && editor.bar}
      {editor.dialogs}
      {layout.length > 0 ? (
        <div className="board">
          {layout.map((cell, i) => {
            const panel = panelIn(cell);
            const next = layout[i + 1] ?? layout[i - 1];
            return (
              <BoardSlot
                key={panel.id}
                cell={cell}
                panel={panel.id}
                editing={editing ? editor.slot(panel, next && panelIn(next).id, noteFor(panel)) : null}
              >
                <HomePanelView panel={panel} ctx={ctx} />
              </BoardSlot>
            );
          })}
        </div>
      ) : (
        !editing && (
          <div className="board-empty">
            <p>
              {arrangement.panels.length === 0
                ? "There are no panels on Home."
                : enabled.length === 0
                  ? "Every panel on Home is hidden."
                  : "None of Home's panels has anything to show yet."}
            </p>
            <Button onClick={() => setEditing(true)} leadingIcon={<CustomizeIcon className="size-4" />}>
              Customize Home
            </Button>
          </div>
        )
      )}
    </div>
  );
}

type Publish = (name: string, resource: ApiResource<unknown> | null) => void;

/** The sources panels draw on beyond Home's own, by name, as their loaders report them. */
function useSources() {
  const [sources, setSources] = useState<Readonly<Record<string, ApiResource<unknown>>>>({});
  const publish = useCallback<Publish>(
    (name, resource) =>
      setSources((prev) => {
        if ((prev[name] ?? null) === resource) return prev;
        const next = { ...prev };
        if (resource) next[name] = resource;
        else delete next[name];
        return next;
      }),
    [],
  );
  return [sources, publish] as const;
}

/**
 * Loads one source and reports it to Home on every change, before paint,
 * so a cached answer shows on the first frame. Rendered per source, so the
 * set of them can follow the board.
 */
function Source<T>({
  name,
  publish,
  load,
  fallback,
  cacheKey,
  initial,
}: {
  name: string;
  publish: Publish;
  load: (signal: AbortSignal) => Promise<T>;
  fallback: string;
  cacheKey?: string;
  initial?: () => T | null;
}) {
  const resource = useApiResource(load, fallback, { cacheKey, initial });
  useLayoutEffect(() => publish(name, resource as ApiResource<unknown>), [name, publish, resource]);
  useLayoutEffect(() => () => publish(name, null), [name, publish]);
  return null;
}

/**
 * A period's numbers, loaded and cached the way the Replay page does, so
 * either warms the other.
 */
function ReplaySource({ name, period, publish }: { name: string; period: Period; publish: Publish }) {
  // Keyed by the period, so its request is fixed for the mount.
  const [request] = useState(() => replayRequest(period));
  return (
    <Source
      name={name}
      publish={publish}
      fallback={replayError(period)}
      initial={() => readReplayCache(request)}
      load={async (signal) => {
        const { query, data } = await fetchReplay(request, signal);
        if (!signal.aborted) storeReplay(request, query, data);
        return data;
      }}
    />
  );
}

function PlaylistSource({ id, publish }: { id: string; publish: Publish }) {
  return (
    <Source
      name={playlistSource(id)}
      publish={publish}
      fallback="Could not load the playlist."
      cacheKey={`home:playlist:${id}`}
      load={async (signal) => (await api.listPlaylistTracks(id, { signal })).tracks.map(playlistEntryToTrack)}
    />
  );
}

/**
 * Asks again once `size` (which the fetcher reads) grows past the size the
 * last request went out with (`sent`, which the fetcher records): a panel
 * moved somewhere roomier gets the rows to fill it. A smaller size waits for
 * the next load.
 */
function useReloadWhenLarger(reload: () => Promise<void>, size: number, sent: MutableRefObject<number>) {
  useEffect(() => {
    if (size > sent.current) void reload();
  }, [reload, size, sent]);
}

/**
 * Plays a list fetched on demand (an album's, a playlist's) or already at
 * hand (an artist's top tracks). When it can't play, `failure` says why, for
 * the panel the Play came from to show. Starting another one, or leaving
 * Home, aborts the fetch, so a late reply never starts playback somewhere
 * the user has moved on from.
 */
function useFetchAndPlay() {
  const { play } = usePlayerControls();
  const request = useRef<AbortController | null>(null);
  const [failure, setFailure] = useState<{ panel: HomePanelId; message: string } | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const playFetched = useCallback(
    async (panel: HomePanelId, label: string, load: (signal: AbortSignal) => Promise<TrackListItem[]>) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setFailure(null);
      let loaded: TrackListItem[] = [];
      let error: unknown = null;
      try {
        loaded = await load(controller.signal);
      } catch (err) {
        error = err;
      }
      if (controller.signal.aborted) return;
      if (playableTracks(loaded).length > 0) {
        startListPlayback(play, loaded, false);
        return;
      }
      setFailure({
        panel,
        message: error
          ? errorMessage(error, `Could not play ${displayText(label)}. Check your connection and try again.`)
          : `${displayText(label)} has nothing that can be played.`,
      });
    },
    [play],
  );
  return { playFetched: (panel: HomePanelId, label: string, load: (signal: AbortSignal) => Promise<TrackListItem[]>) => void playFetched(panel, label, load), failure };
}
