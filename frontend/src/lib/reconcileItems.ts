/** Keep unchanged rows (and the whole list when identical) referentially stable. */
export function reconcileItems<T>(previous: T[], next: T[]): T[] {
  const byId = new Map(previous.map((item, index) => [
    typeof item === "object" && item !== null && "id" in item ? String(item.id) : String(index), item,
  ]));
  const result = next.map((item, index) => {
    const key = typeof item === "object" && item !== null && "id" in item ? String(item.id) : String(index);
    const old = byId.get(key);
    return old !== undefined && JSON.stringify(old) === JSON.stringify(item) ? old : item;
  });
  return result.length === previous.length && result.every((item, index) => item === previous[index]) ? previous : result;
}
