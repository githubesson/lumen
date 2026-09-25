import { useCallback, useState } from "react";
import {
  api,
  type Page,
  type SearchResult,
  type SearchType,
} from "../../api";
import { usePaginatedList, type PageRequest } from "../../lib/usePaginatedList";
import TrackList from "../../components/TrackList";
import ErrorBanner from "../../components/ErrorBanner";
import EmptyState from "../../components/EmptyState";
import LoadingState from "../../components/LoadingState";
import LoadMoreSentinel from "../../components/list/LoadMoreSentinel";
import { Button } from "../../components/Button";
import { AlbumCard, ArtistCard } from "./EntityCards";

export default function SearchResults({
  query,
  type,
  onOpenAlbum,
  onOpenArtist,
}: {
  query: string;
  type: SearchType;
  onOpenAlbum: (id: string) => void;
  onOpenArtist: (id: string, name?: string) => void;
}) {
  // Tagged with the search it came from: results stay mounted across
  // queries, and an old warning mustn't read as the new search's.
  const [taggedWarning, setWarning] = useState<{ search: string; text: string | null }>({
    search: "",
    text: null,
  });
  const fetcher = useCallback(
    async (params: PageRequest): Promise<Page<SearchResult>> => {
      if (!params.q) return { items: [], total: 0, nextOffsets: {} };
      const result = await api.searchPage({ ...params, type });
      const search = `${type}\u0000${params.q}`;
      if (!params.signal.aborted)
        setWarning((previous) => ({
          search,
          text:
            [
              ...new Set(
                [
                  params.offset === 0 || previous.search !== search ? null : previous.text,
                  ...(result.warnings ?? []),
                ].filter(Boolean),
              ),
            ].join(" ") || null,
        }));
      return result;
    },
    [type],
  );
  const warning =
    taggedWarning.search === `${type}\u0000${query.trim()}` ? taggedWarning.text : null;
  const { items, total, hasMore, loadingMore, error, stale, sentinelRef, reload } =
    usePaginatedList(fetcher, query, { pageSize: 25, resourceKey: type, keepPrevious: true });
  const tracks =
    items?.flatMap((result) =>
      result.type === "track" ? [result.item] : [],
    ) ?? [];
  const albums =
    items?.flatMap((result) =>
      result.type === "album" ? [result.item] : [],
    ) ?? [];
  const artists =
    items?.flatMap((result) =>
      result.type === "artist" ? [result.item] : [],
    ) ?? [];
  // The debounced query is still blank for a beat after the first keystroke,
  // and a stale empty page (a type with no hits) says nothing about the next
  // query, so both show as loading rather than "No matching results".
  const searching =
    items === null || !query.trim() || (stale && items.length === 0);
  return (
    <div
      className="refreshable"
      aria-busy={(stale && !searching) || undefined}
      style={{ display: "grid", gap: 18, marginTop: 18 }}
    >
      {error && <ErrorBanner message={error} />}
      {warning && <ErrorBanner message={warning} />}
      {(error || warning) && (
        <div>
          <Button onClick={() => void reload()}>Retry search</Button>
        </div>
      )}
      {searching && <LoadingState label="Searching…" />}
      {!searching && items.length === 0 && !error && !warning && (
        <EmptyState
          title="No matching results."
          hint="Try another search or type."
        />
      )}
      {artists.length > 0 && (
        <section aria-label="Artists">
          <h2>Artists</h2>
          <div className="grid-cards">
            {artists.map((artist) => (
              <ArtistCard
                key={artist.id}
                artist={artist}
                onOpen={onOpenArtist}
              />
            ))}
          </div>
        </section>
      )}
      {albums.length > 0 && (
        <section aria-label="Albums">
          <h2>Albums</h2>
          <div className="grid-cards">
            {albums.map((album) => (
              <AlbumCard key={album.id} album={album} onOpen={onOpenAlbum} />
            ))}
          </div>
        </section>
      )}
      {tracks.length > 0 && (
        <section aria-label="Songs">
          <h2>Songs</h2>
          <TrackList tracks={tracks} queueSource={tracks} />
        </section>
      )}
      <LoadMoreSentinel
        innerRef={sentinelRef}
        hasMore={hasMore}
        items={items}
        total={total}
        loadingMore={loadingMore}
      />
    </div>
  );
}
