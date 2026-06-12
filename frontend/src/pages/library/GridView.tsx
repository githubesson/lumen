import { type Page } from "../../api";
import { usePaginatedList } from "../../lib/usePaginatedList";
import ErrorBanner from "../../components/ErrorBanner";
import EmptyState from "../../components/EmptyState";
import LoadingState from "../../components/LoadingState";
import ListMeta from "../../components/list/ListMeta";
import LoadMoreSentinel from "../../components/list/LoadMoreSentinel";

const POLL_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Generic grid + pagination view backed by usePaginatedList. Collapses the
 * near-identical AlbumsView / ArtistsView (paged fetch, loaded-of-total meta,
 * error banner, loading/empty placeholders, card grid, infinite-scroll
 * sentinel). Callers supply the page fetcher and a card renderer.
 */
export default function GridView<T>({
  fetcher,
  query,
  pageSize,
  unit,
  emptyLabel,
  renderCard,
}: {
  fetcher: (params: {
    limit: number;
    offset: number;
    q?: string;
  }) => Promise<Page<T>>;
  query: string;
  pageSize: number;
  unit: string;
  emptyLabel: string;
  renderCard: (item: T) => React.ReactNode;
}) {
  const { items, total, loadingMore, error, sentinelRef } = usePaginatedList(
    fetcher,
    query,
    { pageSize, pollIntervalMs: POLL_INTERVAL_MS },
  );

  return (
    <>
      <ListMeta loaded={items?.length ?? 0} total={total} unit={unit} />
      {error && <ErrorBanner message={error} />}
      <div style={{ marginTop: 14 }}>
        {items === null && <LoadingState label="Loading library…" />}
        {items && items.length === 0 && !error && (
          <EmptyState title={emptyLabel} />
        )}
        {items && items.length > 0 && (
          <div className="grid-cards">{items.map(renderCard)}</div>
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
