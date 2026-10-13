/** A menu's items that can take focus, in document order. */
export function menuItems(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[role^="menuitem"]')].filter(
    (item) => !(item as HTMLButtonElement).disabled,
  );
}

/**
 * Arrow-key movement through a menu whose items are laid out in rows: a lone
 * item is a row of one, and the items inside a `[data-menu-row]` element (an
 * icon row, a footer of buttons) share one row. Up and Down move between
 * rows, wrapping at the ends and keeping the column where they can; Left and
 * Right move within a row; Home and End go to the first and last item.
 * Disabled items are skipped.
 *
 * Returns the item to focus, or null when the key doesn't move.
 */
export function menuKeyTarget(
  root: HTMLElement,
  active: Element | null,
  key: string,
): HTMLElement | null {
  const items = menuItems(root);
  if (items.length === 0) return null;

  const rows: HTMLElement[][] = [];
  let lastRow: Element | null = null;
  for (const item of items) {
    const row = item.closest("[data-menu-row]") ?? item;
    if (row !== lastRow) rows.push([]);
    rows[rows.length - 1].push(item);
    lastRow = row;
  }

  const r = rows.findIndex((row) => row.includes(active as HTMLElement));
  const c = r < 0 ? -1 : rows[r].indexOf(active as HTMLElement);
  const first = items[0];
  const last = items[items.length - 1];
  const at = (row: number) => rows[row][Math.min(Math.max(c, 0), rows[row].length - 1)];

  switch (key) {
    case "Home":
      return first;
    case "End":
      return last;
    case "ArrowDown":
      return r < 0 ? first : at((r + 1) % rows.length);
    case "ArrowUp":
      return r < 0 ? last : at((r - 1 + rows.length) % rows.length);
    case "ArrowRight":
      return r < 0 ? first : (rows[r][c + 1] ?? null);
    case "ArrowLeft":
      return r < 0 ? first : (rows[r][c - 1] ?? null);
    default:
      return null;
  }
}

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function canTakeFocus(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement) || !el.isConnected || !el.matches(FOCUSABLE)) return false;
  if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  return typeof el.checkVisibility === "function" ? el.checkVisibility() : true;
}

/**
 * Where focus goes when a context menu closes. `opener` had focus when it
 * opened and `anchor` is the element that was right-clicked. Focus goes back
 * to the opener when it sits in the anchor (a keyboard open, or a right-click
 * on a button). A table row can't take focus, and a right-click on one leaves
 * focus on the page (or a container around the row), so it goes to the
 * anchor's first control instead: a track row's play button, or its checkbox
 * while selecting. With neither, back to the opener if that's a real element.
 */
export function focusReturnTarget(
  opener: HTMLElement | null,
  anchor: Element | null | undefined,
): HTMLElement | null {
  if (opener && anchor?.contains(opener) && canTakeFocus(opener)) return opener;
  if (anchor?.isConnected) {
    const own = [anchor, ...anchor.querySelectorAll(FOCUSABLE)].find(canTakeFocus);
    if (own) return own;
  }
  return opener && opener !== document.body && canTakeFocus(opener) ? opener : null;
}
