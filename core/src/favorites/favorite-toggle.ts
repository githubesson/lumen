/**
 * The optimistic-toggle transition, as pure functions.
 *
 * The two clients store favorites differently and should keep doing so: the
 * web holds a `Set<string>` in context, while mobile holds the full rows in a
 * React Query cache so a single row can subscribe to its own boolean without
 * re-rendering the list. What they must agree on is the *transition* — and
 * that is where both copies had subtly different rollback logic.
 *
 * Both are expressed as "set membership to `favorited`" rather than "flip it",
 * which is what makes them idempotent: a toggle that lands twice, or a
 * rollback for a track another toggle already restored, converges instead of
 * flipping back and forth.
 */

/** Set-of-ids form, for the context-backed provider. */
export function withFavoriteId(
  ids: ReadonlySet<string>,
  id: string,
  favorited: boolean,
): Set<string> {
  const next = new Set(ids);
  if (favorited) next.add(id);
  else next.delete(id);
  return next;
}

/**
 * Row-list form, for the query-cache-backed provider. Newly favorited tracks
 * go to the front, matching the server's most-recent-first ordering, so the
 * optimistic row lands where the refetch will put it.
 *
 * Returns the original array reference when nothing changes, so React Query
 * can skip notifying subscribers.
 */
export function withFavorite<T extends { id: string }>(
  rows: T[],
  track: T,
  favorited: boolean,
): T[] {
  const present = rows.some((row) => row.id === track.id);
  if (favorited) return present ? rows : [track, ...rows];
  return present ? rows.filter((row) => row.id !== track.id) : rows;
}
