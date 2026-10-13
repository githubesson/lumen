import type { HomeBoardTweak } from "../../contracts/desktop";
import type { BoardCell } from "./boardLayout";

/**
 * How Home is arranged on this device: which panel fills each of the
 * board's slots, and which panels are hidden.
 *
 * The board's slots keep the shapes `boardLayout` gives them; moving a
 * panel swaps it with the panel in the slot it lands on. Slots are named
 * for the panel that fills them by default, so with Albums and Recently
 * played swapped, slot "albums" holds Recently played. A hidden panel
 * keeps its slot, which the board leaves out the way it leaves out an
 * empty list, and gets it back when shown again.
 */

/** The search param that puts Home in customizing mode (`/?customize`). */
export const CUSTOMIZE_PARAM = "customize";
export const CUSTOMIZE_HOME_PATH = `/?${CUSTOMIZE_PARAM}`;

/** Every panel on Home, Jump back in included. */
export type HomePanelId = BoardCell["id"];

/** The panels in their default slots, in board order. */
export const HOME_PANELS: readonly HomePanelId[] = [
  "resume",
  "repeat",
  "recent",
  "favorites",
  "albums",
  "playlists",
  "artists",
];

export const HOME_PANEL_TITLES: Record<HomePanelId, string> = {
  resume: "Jump back in",
  repeat: "On repeat",
  recent: "Recently played",
  favorites: "Your favorites",
  albums: "Albums",
  playlists: "Playlists",
  artists: "Top artists",
};

export interface HomeArrangement {
  /** The panel in each slot: `slots[i]` sits where `HOME_PANELS[i]` does by default. */
  slots: readonly HomePanelId[];
  hidden: ReadonlySet<HomePanelId>;
}

export const DEFAULT_ARRANGEMENT: HomeArrangement = { slots: HOME_PANELS, hidden: new Set() };

const isPanel = (id: unknown): id is HomePanelId => HOME_PANELS.includes(id as HomePanelId);

/**
 * The arrangement a saved tweak describes. Anything it doesn't account for
 * (a panel added since, a slot written by a newer build) falls back to the
 * default, so a bad or stale value never loses a panel or shows one twice.
 */
export function readArrangement(saved: HomeBoardTweak | null | undefined): HomeArrangement {
  if (!saved || typeof saved !== "object") return DEFAULT_ARRANGEMENT;
  const used = new Set<HomePanelId>();
  const slots: (HomePanelId | null)[] = HOME_PANELS.map((_, i) => {
    const id = Array.isArray(saved.slots) ? saved.slots[i] : undefined;
    if (!isPanel(id) || used.has(id)) return null;
    used.add(id);
    return id;
  });
  // Unclaimed slots take the panels left over, in default order.
  const spare = HOME_PANELS.filter((id) => !used.has(id));
  const hidden = Array.isArray(saved.hidden) ? saved.hidden.filter(isPanel) : [];
  return { slots: slots.map((id) => id ?? spare.shift()!), hidden: new Set(hidden) };
}

/** The tweak to save, or undefined for the default arrangement. */
export function arrangementTweak(arrangement: HomeArrangement): HomeBoardTweak | undefined {
  if (isDefaultArrangement(arrangement)) return undefined;
  return {
    slots: [...arrangement.slots],
    hidden: HOME_PANELS.filter((id) => arrangement.hidden.has(id)),
  };
}

export function isDefaultArrangement(arrangement: HomeArrangement): boolean {
  return arrangement.hidden.size === 0 && arrangement.slots.every((id, i) => id === HOME_PANELS[i]);
}

/** The panel in a slot. */
export function panelIn(arrangement: HomeArrangement, slot: HomePanelId): HomePanelId {
  return arrangement.slots[HOME_PANELS.indexOf(slot)];
}

/** Puts `a` in `b`'s slot and `b` in `a`'s. */
export function swapPanels(arrangement: HomeArrangement, a: HomePanelId, b: HomePanelId): HomeArrangement {
  if (a === b) return arrangement;
  const slots = arrangement.slots.map((id) => (id === a ? b : id === b ? a : id));
  return { ...arrangement, slots };
}

export function setPanelHidden(arrangement: HomeArrangement, id: HomePanelId, hidden: boolean): HomeArrangement {
  if (arrangement.hidden.has(id) === hidden) return arrangement;
  const next = new Set(arrangement.hidden);
  if (hidden) next.add(id);
  else next.delete(id);
  return { ...arrangement, hidden: next };
}
