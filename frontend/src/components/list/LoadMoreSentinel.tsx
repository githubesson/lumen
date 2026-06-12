import LoadingState from "../LoadingState";

/**
 * Bottom infinite-scroll sentinel plus the "Loading more…" hint. The thin
 * sentinel div is observed by usePaginatedList; it renders only while there
 * are more items to fetch. Extracted from Library's duplicated Sentinel +
 * LoadingMoreHint pair.
 */
export default function LoadMoreSentinel({
  innerRef,
  items,
  total,
  loadingMore,
}: {
  innerRef: React.Ref<HTMLDivElement>;
  items: unknown[] | null;
  total: number | null;
  loadingMore: boolean;
}) {
  const hasMore = items !== null && total !== null && items.length < total;
  return (
    <>
      {hasMore && <div ref={innerRef} aria-hidden="true" style={{ height: 1 }} />}
      {loadingMore && <LoadingState label="Loading more…" />}
    </>
  );
}
