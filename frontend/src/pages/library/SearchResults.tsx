import { useCallback, useEffect, useState } from "react";
import {
  api,
  errorMessage,
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
  const [warning, setWarning] = useState<string | null>(null);
  const fetcher = useCallback(
    async (params: PageRequest): Promise<Page<SearchResult>> => {
      if (!params.q) return { items: [], total: 0, nextOffsets: {} };
      const result = await api.searchPage({ ...params, type });
      if (!params.signal.aborted)
        setWarning(
          (previous) =>
            [
              ...new Set(
                [
                  params.offset === 0 ? null : previous,
                  ...(result.warnings ?? []),
                ].filter(Boolean),
              ),
            ].join(" ") || null,
        );
      return result;
    },
    [type],
  );
  const { items, total, hasMore, loadingMore, error, sentinelRef, reload } =
    usePaginatedList(fetcher, query, { pageSize: 25, resourceKey: type });
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
  return (
    <div style={{ display: "grid", gap: 18, marginTop: 18 }}>
      {error && <ErrorBanner message={error} />}
      {warning && <ErrorBanner message={warning} />}
      {(error || warning) && (
        <div>
          <Button onClick={() => void reload()}>Retry search</Button>
        </div>
      )}
      {items === null && <LoadingState label="Searching…" />}
      {items?.length === 0 && !error && (
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

export function TidalArtistResults({
  id,
  name,
  onBack,
  onOpenAlbum,
}: {
  id: string;
  name: string;
  onBack: () => void;
  onOpenAlbum: (id: string) => void;
}) {
  const [data, setData] = useState<Awaited<
    ReturnType<typeof api.getTidalArtist>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api
      .getTidalArtist(id, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setError(errorMessage(err, "Couldn't load artist."));
      });
    return () => controller.abort();
  }, [id]);
  return (
    <div className="view" style={{ display: "grid", gap: 18 }}>
      <div>
        <Button onClick={onBack}>Back to search</Button>
      </div>
      <h1>{name}</h1>
      {error && <ErrorBanner message={error} />}
      {!data && !error && <LoadingState label="Loading artist…" />}
      {data && (
        <>
          {data.tracks.length > 0 && (
            <section>
              <h2>Top songs</h2>
              <TrackList tracks={data.tracks} queueSource={data.tracks} />
            </section>
          )}
          {data.albums.length > 0 && (
            <section>
              <h2>Albums</h2>
              <div className="grid-cards">
                {data.albums.map((album) => (
                  <AlbumCard
                    key={album.id}
                    album={album}
                    onOpen={onOpenAlbum}
                  />
                ))}
              </div>
            </section>
          )}
          {!data.albums.length && !data.tracks.length && (
            <EmptyState title="No releases found." />
          )}
        </>
      )}
    </div>
  );
}
