import { useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Bars3BottomLeftIcon,
  PlayIcon,
  Squares2X2Icon,
} from "@heroicons/react/16/solid";
import {
  api,
  albumCoverUrl,
  trackCoverUrl,
  type Album,
  type Artist,
  type Page,
  type TrackListItem,
} from "../api";
import { displayText, pluralize } from "../lib/format";
import TrackList from "../components/TrackList";
import CoverArt from "../components/CoverArt";
import ErrorBanner from "../components/ErrorBanner";
import EmptyState from "../components/EmptyState";
import LoadingState from "../components/LoadingState";
import ListMeta from "../components/list/ListMeta";
import LoadMoreSentinel from "../components/list/LoadMoreSentinel";
import SearchInput from "../components/SearchInput";
import SegmentedControl from "../components/SegmentedControl";
import { useTrackContextMenu } from "../components/TrackContextMenu";
import { usePlayer } from "../context/Player";
import { usePaginatedList } from "../lib/usePaginatedList";
import GridView from "./library/GridView";
import {
  AlbumDetailView,
  ArtistDetailView,
  TidalAlbumDetailView,
} from "./library/LibraryDetail";

const POLL_INTERVAL_MS = 15 * 60 * 1000;

type View = "tracks" | "artists" | "albums";
type SortKey = "recent" | "title" | "artist" | "album" | "duration";

const sortLabels: Record<SortKey, string> = {
  recent: "Recently added",
  title: "Title",
  artist: "Artist",
  album: "Album",
  duration: "Duration",
};

function isView(v: string | null): v is View {
  return v === "tracks" || v === "artists" || v === "albums";
}

export default function Library() {
  const [params, setParams] = useSearchParams();
  const view: View = isView(params.get("view"))
    ? (params.get("view") as View)
    : "tracks";
  const albumID = params.get("album");
  const tidalAlbumID = params.get("tidalAlbum");
  const artistID = params.get("artist");
  const query = params.get("q") ?? "";

  const setView = (v: View) => {
    const next = new URLSearchParams(params);
    if (v === "tracks") next.delete("view");
    else next.set("view", v);
    next.delete("album");
    next.delete("artist");
    setParams(next, { replace: true });
  };

  const setQuery = (q: string) => {
    const next = new URLSearchParams(params);
    if (q) next.set("q", q);
    else next.delete("q");
    setParams(next, { replace: true });
  };

  const openAlbum = (id: string) => {
    const next = new URLSearchParams();
    next.set("view", "albums");
    next.set("album", id);
    setParams(next);
  };

  const openArtist = (id: string) => {
    const next = new URLSearchParams();
    next.set("view", "artists");
    next.set("artist", id);
    setParams(next);
  };

  const clearDrill = () => {
    const next = new URLSearchParams();
    if (view !== "tracks") next.set("view", view);
    setParams(next, { replace: true });
  };

  if (albumID) {
    return <AlbumDetailView key={albumID} id={albumID} onBack={clearDrill} />;
  }
  if (tidalAlbumID) {
    return (
      <TidalAlbumDetailView
        key={tidalAlbumID}
        id={tidalAlbumID}
        onBack={clearDrill}
      />
    );
  }
  if (artistID) {
    return <ArtistDetailView key={artistID} id={artistID} onBack={clearDrill} />;
  }

  return (
    <LibraryBrowse
      view={view}
      query={query}
      onViewChange={setView}
      onQueryChange={setQuery}
      onOpenAlbum={openAlbum}
      onOpenArtist={openArtist}
    />
  );
}

function LibraryBrowse({
  view,
  query,
  onViewChange,
  onQueryChange,
  onOpenAlbum,
  onOpenArtist,
}: {
  view: View;
  query: string;
  onViewChange: (v: View) => void;
  onQueryChange: (q: string) => void;
  onOpenAlbum: (id: string) => void;
  onOpenArtist: (id: string) => void;
}) {
  const [displayMode, setDisplayMode] = useState<"grid" | "list">("list");
  const [sort, setSort] = useState<SortKey>("recent");

  return (
    <div className="view">
      <LibraryHeader>
        <span>{labelFor(view)}</span>
      </LibraryHeader>

      <BrowseToolbar
        view={view}
        query={query}
        onViewChange={onViewChange}
        onQueryChange={onQueryChange}
        displayMode={displayMode}
        onDisplayModeChange={setDisplayMode}
        sort={sort}
        onSortChange={setSort}
      />

      {view === "tracks" && (
        <TracksView query={query} sort={sort} displayMode={displayMode} />
      )}
      {view === "albums" && <AlbumsView query={query} onOpen={onOpenAlbum} />}
      {view === "artists" && <ArtistsView query={query} onOpen={onOpenArtist} />}
    </div>
  );
}

function LibraryHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header
      style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}
    >
      <h1
        style={{
          fontSize: 28,
          fontWeight: 600,
          letterSpacing: "-0.02em",
          margin: 0,
        }}
      >
        Library
      </h1>
      <div className="mono" style={{ color: "var(--fg-subtle)", fontSize: 11 }}>
        {children}
      </div>
    </header>
  );
}

function labelFor(view: View) {
  switch (view) {
    case "tracks":
      return "Tracks";
    case "albums":
      return "Albums";
    case "artists":
      return "Artists";
  }
}

function BrowseToolbar({
  view,
  query,
  onViewChange,
  onQueryChange,
  displayMode,
  onDisplayModeChange,
  sort,
  onSortChange,
}: {
  view: View;
  query: string;
  onViewChange: (v: View) => void;
  onQueryChange: (q: string) => void;
  displayMode: "grid" | "list";
  onDisplayModeChange: (m: "grid" | "list") => void;
  sort: SortKey;
  onSortChange: (s: SortKey) => void;
}) {
  return (
    <div
      style={{
        marginTop: 18,
        display: "flex",
        gap: 12,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <SegmentedControl
        aria-label="View"
        value={view}
        onChange={onViewChange}
        options={(["tracks", "albums", "artists"] as View[]).map((v) => ({
          value: v,
          label: labelFor(v),
        }))}
      />

      <div style={{ flex: 1 }} />

      <SearchInput
        style={{ width: 260 }}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder={
          view === "albums"
            ? "Search albums"
            : view === "artists"
              ? "Search artists"
              : "Search local + TIDAL"
        }
      />

      {view === "tracks" && (
        <select
          className="input"
          style={{ width: "auto" }}
          value={sort}
          onChange={(e) => onSortChange(e.target.value as SortKey)}
          aria-label="Sort"
        >
          {(Object.keys(sortLabels) as SortKey[]).map((k) => (
            <option key={k} value={k}>
              {sortLabels[k]}
            </option>
          ))}
        </select>
      )}

      {view === "tracks" && (
        <SegmentedControl
          aria-label="Display mode"
          value={displayMode}
          onChange={onDisplayModeChange}
          options={[
            {
              value: "list",
              label: <Bars3BottomLeftIcon className="size-3.5" />,
              ariaLabel: "List",
            },
            {
              value: "grid",
              label: <Squares2X2Icon className="size-3.5" />,
              ariaLabel: "Grid",
            },
          ]}
        />
      )}
    </div>
  );
}

function TracksView({
  query,
  sort,
  displayMode,
}: {
  query: string;
  sort: SortKey;
  displayMode: "grid" | "list";
}) {
  const [searchWarning, setSearchWarning] = useState<string | null>(null);
  const fetcher = useCallback(async (p: {
    limit: number;
    offset: number;
    q?: string;
  }): Promise<Page<TrackListItem>> => {
    if (p.q?.trim()) {
      const res = await api.searchTracks({ ...p, limit: Math.min(p.limit, 50) });
      setSearchWarning(res.warnings?.join(" ") || null);
      return {
        items: res.tracks ?? [],
        total: p.offset + (res.tracks?.length ?? 0),
      };
    }
    setSearchWarning(null);
    return api.listTracksPage(p);
  }, []);
  const { items, total, loadingMore, error, sentinelRef } = usePaginatedList(
    fetcher,
    query,
    { pageSize: 100, pollIntervalMs: POLL_INTERVAL_MS },
  );
  const { play } = usePlayer();

  // Memoize the sort so player timer ticks and unrelated parent re-renders
  // don't re-allocate + re-sort a 600-item array (and bust child referential
  // equality downstream). Recomputes only when the source list or key change.
  const sorted = useMemo(() => sortTracks(items ?? [], sort), [items, sort]);

  return (
    <>
      <ListMeta loaded={sorted.length} total={total} unit="track" />
      {error && <ErrorBanner message={error} />}
      {!error && searchWarning && <ErrorBanner message={searchWarning} />}
      <div style={{ marginTop: 14 }}>
        {items === null && <LoadingState label="Loading library…" />}
        {items && items.length === 0 && !error && <LibraryEmptyState />}
        {items && items.length > 0 && displayMode === "list" && (
          <TrackList tracks={sorted} queueSource={sorted} />
        )}
        {items && items.length > 0 && displayMode === "grid" && (
          <TracksGrid tracks={sorted} onPlay={(t) => play(t, sorted)} />
        )}
        <LoadMoreSentinel
          innerRef={sentinelRef}
          items={items}
          total={total}
          loadingMore={loadingMore}
        />
      </div>
    </>
  );
}

function AlbumsView({
  query,
  onOpen,
}: {
  query: string;
  onOpen: (id: string) => void;
}) {
  const fetcher = useCallback(
    (p: { limit: number; offset: number; q?: string }) => api.listAlbumsPage(p),
    [],
  );
  return (
    <GridView<Album>
      fetcher={fetcher}
      query={query}
      pageSize={60}
      unit="album"
      emptyLabel="No albums found."
      renderCard={(a) => <AlbumCard key={a.id} album={a} onOpen={onOpen} />}
    />
  );
}

function ArtistsView({
  query,
  onOpen,
}: {
  query: string;
  onOpen: (id: string) => void;
}) {
  const fetcher = useCallback(
    (p: { limit: number; offset: number; q?: string }) => api.listArtistsPage(p),
    [],
  );
  return (
    <GridView<Artist>
      fetcher={fetcher}
      query={query}
      pageSize={60}
      unit="artist"
      emptyLabel="No artists found."
      renderCard={(a) => <ArtistCard key={a.id} artist={a} onOpen={onOpen} />}
    />
  );
}

function TracksGrid({
  tracks,
  onPlay,
}: {
  tracks: TrackListItem[];
  onPlay: (t: TrackListItem) => void;
}) {
  const { bind, menu } = useTrackContextMenu();
  return (
    <div className="grid-cards">
      {menu}
      {tracks.map((t) => (
        <div
          key={t.id}
          className="card"
          onContextMenu={bind(t, { queue: tracks })}
        >
          <CoverArt
            className="card-art"
            src={trackCoverUrl(t)}
            seed={t.album_id ?? t.id}
            label={t.album_title || t.title}
          >
            <button
              type="button"
              className="card-play"
              onClick={() => onPlay(t)}
              aria-label={`Play ${t.title}`}
            >
              <PlayIcon className="size-4" />
            </button>
          </CoverArt>
          <div>
            <div className="card-title">{displayText(t.title)}</div>
            <div className="card-sub">{displayText(t.artist, "Unknown artist")}</div>
            {t.source === "tidal" && (
              <span className="badge" style={{ marginTop: 6 }}>
                TIDAL
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function AlbumCard({
  album: a,
  onOpen,
}: {
  album: Album;
  onOpen: (id: string) => void;
}) {
  return (
    <button type="button" className="card" onClick={() => onOpen(a.id)}>
      <CoverArt
        className="card-art"
        src={a.has_cover ? albumCoverUrl(a.id) : null}
        seed={a.id}
        label={a.title}
        forcePlaceholder={!a.has_cover}
      />
      <div>
        <div className="card-title">{displayText(a.title)}</div>
        <div className="card-sub">
          {displayText(
            a.artist_name || (a.is_compilation ? "Various Artists" : "Unknown artist"),
          )}{" "}
          · {a.track_count}
        </div>
      </div>
    </button>
  );
}

function ArtistCard({
  artist: a,
  onOpen,
}: {
  artist: Artist;
  onOpen: (id: string) => void;
}) {
  return (
    <button type="button" className="card" onClick={() => onOpen(a.id)}>
      <CoverArt
        className="card-art"
        seed={a.id}
        label={a.name}
        radius={999}
        forcePlaceholder
      />
      <div style={{ textAlign: "center" }}>
        <div className="card-title">{displayText(a.name)}</div>
        <div className="card-sub">
          {pluralize(a.track_count, "track")}
          {a.album_count > 0 && <> · {pluralize(a.album_count, "album")}</>}
        </div>
      </div>
    </button>
  );
}

function sortTracks(tracks: TrackListItem[], sort: SortKey): TrackListItem[] {
  if (sort === "recent") return tracks;
  const list = [...tracks];
  switch (sort) {
    case "title":
      list.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case "artist":
      list.sort((a, b) => (a.artist ?? "").localeCompare(b.artist ?? ""));
      break;
    case "album":
      list.sort((a, b) =>
        (a.album_title ?? "").localeCompare(b.album_title ?? ""),
      );
      break;
    case "duration":
      list.sort((a, b) => a.duration_ms - b.duration_ms);
      break;
  }
  return list;
}

function LibraryEmptyState() {
  return (
    <EmptyState
      title="Your library is empty."
      hint={
        <>
          Drop audio files into a watched folder on the server, or{" "}
          <Link to="#" className="section-link" style={{ color: "var(--accent)" }}>
            upload them
          </Link>
          . New files are ingested automatically.
        </>
      }
    />
  );
}
