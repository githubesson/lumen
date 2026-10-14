import type { HomeBoardTweak, HomePanelTweak } from "../../contracts/desktop";
import { parsePeriodKey, periodKey, type Period } from "@music-library/core/replay/period";
import {
  DEFAULT_PERIOD,
  PANEL_HEIGHTS,
  PANEL_KINDS,
  PANEL_WIDTHS,
  allowsMany,
  type PanelHeight,
  type PanelKind,
  type PanelWidth,
} from "./panelKinds";

/**
 * How Home is arranged on this device: the panels on it in board order,
 * each with its size and what it shows, and which of them are hidden.
 *
 * While the board has the default panels in their default sizes (in any
 * order, some maybe hidden), `boardLayout` lays it out, adapting to empty
 * and hidden panels as designed. Once panels are added, removed or resized,
 * it's packed from the panels' own sizes (`packBoard`). Moving a panel swaps
 * it with the one it lands on, sizes staying where they were, so the board
 * keeps its shape. A hidden panel keeps its place and settings, and gets
 * them back when shown again; a removed one is gone.
 */

/** The search param that puts Home in customizing mode (`/?customize`). */
export const CUSTOMIZE_PARAM = "customize";
export const CUSTOMIZE_HOME_PATH = `/?${CUSTOMIZE_PARAM}`;

/** A panel on Home: one kind can be there more than once, under ids of their own. */
export type HomePanelId = string;

export interface HomePanel {
  /** Its kind for the only one of a kind, else the kind and a number ("repeat-2"). */
  id: HomePanelId;
  kind: PanelKind;
  w: PanelWidth;
  h: PanelHeight;
  hidden: boolean;
  /** A name of the user's own, in place of the kind's title. */
  title?: string;
  /** The Replay period a period kind shows. */
  period?: Period;
  /** The playlist a playlist panel shows. */
  playlist?: string;
}

export interface HomeArrangement {
  /** In board order, hidden ones included. */
  panels: readonly HomePanel[];
}

/** The panels Home starts with, in board order. Also the default board's slots. */
export const DEFAULT_PANEL_IDS = ["resume", "repeat", "recent", "favorites", "albums", "playlists", "artists"] as const;

/** At most this many panels, hidden ones included: each can mean a request. */
export const MAX_PANELS = 24;
export const MAX_TITLE_LENGTH = 60;

export function newPanel(kind: PanelKind, id: HomePanelId = kind): HomePanel {
  const info = PANEL_KINDS[kind];
  return { id, kind, w: info.w, h: info.h, hidden: false, ...(info.period ? { period: DEFAULT_PERIOD } : {}) };
}

export const DEFAULT_ARRANGEMENT: HomeArrangement = {
  panels: DEFAULT_PANEL_IDS.map((kind) => newPanel(kind)),
};

const isKind = (kind: unknown): kind is PanelKind => typeof kind === "string" && Object.hasOwn(PANEL_KINDS, kind);
const isWidth = (w: unknown): w is PanelWidth => PANEL_WIDTHS.includes(w as PanelWidth);
const isHeight = (h: unknown): h is PanelHeight => PANEL_HEIGHTS.includes(h as PanelHeight);

/** Its kind, or its kind and a number of 2 or more. */
function idFits(id: unknown, kind: PanelKind, many: boolean): id is string {
  if (id === kind) return true;
  if (!many || typeof id !== "string" || !id.startsWith(`${kind}-`)) return false;
  return /^[1-9]\d{0,3}$/.test(id.slice(kind.length + 1)) && id !== `${kind}-1`;
}

/** The first of `kind`, `kind-2`, `kind-3`… not in `used`. */
function freeId(kind: PanelKind, used: ReadonlySet<string>): HomePanelId {
  if (!used.has(kind)) return kind;
  for (let n = 2; ; n++) if (!used.has(`${kind}-${n}`)) return `${kind}-${n}`;
}

export function cleanTitle(title: unknown): string | undefined {
  if (typeof title !== "string") return undefined;
  const clean = title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH).trim();
  return clean || undefined;
}

/**
 * The arrangement a saved tweak describes. Whatever it gets wrong (a kind
 * this build doesn't know, a second Jump back in, a size out of range) is
 * dropped or falls back to the kind's default, so a bad or stale value never
 * shows a panel twice or breaks the board.
 */
export function readArrangement(saved: HomeBoardTweak | null | undefined): HomeArrangement {
  if (!saved || typeof saved !== "object") return DEFAULT_ARRANGEMENT;
  if (Array.isArray(saved.panels)) return readPanels(saved.panels);
  if (Array.isArray(saved.slots) || Array.isArray(saved.hidden)) return readSlots(saved);
  return DEFAULT_ARRANGEMENT;
}

function readPanels(list: readonly unknown[]): HomeArrangement {
  const used = new Set<string>();
  const panels: HomePanel[] = [];
  for (const entry of list) {
    if (panels.length >= MAX_PANELS) break;
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Partial<Record<keyof HomePanelTweak, unknown>>;
    const kind = raw.kind;
    if (!isKind(kind)) continue;
    const info = PANEL_KINDS[kind];
    const many = allowsMany(kind);
    if (!many && used.has(kind)) continue;
    // A playlist panel is nothing without its playlist.
    if (info.playlist && (typeof raw.playlist !== "string" || !raw.playlist)) continue;
    const id = idFits(raw.id, kind, many) && !used.has(raw.id) ? raw.id : freeId(kind, used);
    used.add(id);
    const panel: HomePanel = {
      id,
      kind,
      w: isWidth(raw.w) ? raw.w : info.w,
      h: isHeight(raw.h) ? raw.h : info.h,
      hidden: raw.hidden === true,
    };
    const title = cleanTitle(raw.title);
    if (title) panel.title = title;
    if (info.period) panel.period = parsePeriodKey(typeof raw.period === "string" ? raw.period : null) ?? DEFAULT_PERIOD;
    if (info.playlist) panel.playlist = raw.playlist as string;
    panels.push(panel);
  }
  return { panels };
}

/**
 * The first customizing build saved which default panel filled each of the
 * seven slots (`slots[i]` in the place of `DEFAULT_PANEL_IDS[i]`) and which
 * were hidden. Each panel takes the shape of the slot it was in.
 */
function readSlots(saved: HomeBoardTweak): HomeArrangement {
  const isDefault = (id: unknown): id is PanelKind => DEFAULT_PANEL_IDS.includes(id as (typeof DEFAULT_PANEL_IDS)[number]);
  const used = new Set<PanelKind>();
  const slots: (PanelKind | null)[] = DEFAULT_PANEL_IDS.map((_, i) => {
    const id = Array.isArray(saved.slots) ? saved.slots[i] : undefined;
    if (!isDefault(id) || used.has(id)) return null;
    used.add(id);
    return id;
  });
  // Unclaimed slots take the panels left over, in default order.
  const spare: PanelKind[] = DEFAULT_PANEL_IDS.filter((id) => !used.has(id));
  const hidden = new Set(Array.isArray(saved.hidden) ? saved.hidden : []);
  return {
    panels: slots.map((id, i) => {
      const kind = id ?? spare.shift()!;
      const shape = PANEL_KINDS[DEFAULT_PANEL_IDS[i]];
      return { ...newPanel(kind), w: shape.w, h: shape.h, hidden: hidden.has(kind) };
    }),
  };
}

/** The tweak to save, or undefined for the default board. */
export function arrangementTweak(arrangement: HomeArrangement): HomeBoardTweak | undefined {
  if (isDefaultArrangement(arrangement)) return undefined;
  return {
    panels: arrangement.panels.map((panel) => {
      const out: HomePanelTweak = { id: panel.id, kind: panel.kind, w: panel.w, h: panel.h };
      if (panel.hidden) out.hidden = true;
      if (panel.title) out.title = panel.title;
      if (panel.period) out.period = periodKey(panel.period);
      if (panel.playlist) out.playlist = panel.playlist;
      return out;
    }),
  };
}

const samePeriod = (a: Period | undefined, b: Period | undefined) =>
  (a ? periodKey(a) : undefined) === (b ? periodKey(b) : undefined);

export function isDefaultArrangement(arrangement: HomeArrangement): boolean {
  const { panels } = arrangement;
  return (
    panels.length === DEFAULT_ARRANGEMENT.panels.length &&
    panels.every((panel, i) => {
      const usual = DEFAULT_ARRANGEMENT.panels[i];
      return (
        panel.id === usual.id &&
        panel.w === usual.w &&
        panel.h === usual.h &&
        !panel.hidden &&
        !panel.title &&
        samePeriod(panel.period, usual.period)
      );
    })
  );
}

/**
 * The panel in each of the default board's slots (`DEFAULT_PANEL_IDS`
 * order), while the board still has its shape: the default panels, each
 * once, in the default sizes, whatever order they're in and whichever are
 * hidden. Such a board keeps the default layout, which adapts to empty and
 * hidden panels as designed. Null once panels are added, removed or resized.
 */
export function defaultSlots(arrangement: HomeArrangement): readonly HomePanel[] | null {
  const { panels } = arrangement;
  if (panels.length !== DEFAULT_PANEL_IDS.length) return null;
  const kinds = new Set(panels.map((panel) => panel.kind));
  if (!DEFAULT_PANEL_IDS.every((kind) => kinds.has(kind))) return null;
  const shaped = panels.every((panel, i) => {
    const slot = PANEL_KINDS[DEFAULT_PANEL_IDS[i]];
    return panel.w === slot.w && panel.h === slot.h;
  });
  return shaped ? panels : null;
}

export function findPanel(arrangement: HomeArrangement, id: HomePanelId): HomePanel | undefined {
  return arrangement.panels.find((panel) => panel.id === id);
}

/** Puts `a` where `b` is and `b` where `a` is; the sizes stay with the places. */
export function swapPanels(arrangement: HomeArrangement, a: HomePanelId, b: HomePanelId): HomeArrangement {
  const from = findPanel(arrangement, a);
  const to = findPanel(arrangement, b);
  if (a === b || !from || !to) return arrangement;
  const panels = arrangement.panels.map((panel) =>
    panel.id === a ? { ...to, w: from.w, h: from.h } : panel.id === b ? { ...from, w: to.w, h: to.h } : panel,
  );
  return { panels };
}

export function setPanelHidden(arrangement: HomeArrangement, id: HomePanelId, hidden: boolean): HomeArrangement {
  const panel = findPanel(arrangement, id);
  if (!panel || panel.hidden === hidden) return arrangement;
  return updatePanel(arrangement, id, { hidden });
}

export type PanelChange = Partial<Pick<HomePanel, "w" | "h" | "hidden" | "title" | "period" | "playlist">>;

export function updatePanel(arrangement: HomeArrangement, id: HomePanelId, change: PanelChange): HomeArrangement {
  return {
    panels: arrangement.panels.map((panel) => {
      if (panel.id !== id) return panel;
      const next = { ...panel, ...change };
      // An emptied name goes back to the kind's title.
      if ("title" in change && !cleanTitle(change.title)) delete next.title;
      else if (next.title) next.title = cleanTitle(next.title);
      return next;
    }),
  };
}

/** Whether one more `kind` can go on the board (or an existing one be shown). */
export function canAdd(arrangement: HomeArrangement, kind: PanelKind): boolean {
  if (!allowsMany(kind) && arrangement.panels.some((panel) => panel.kind === kind)) {
    return arrangement.panels.some((panel) => panel.kind === kind && panel.hidden);
  }
  return arrangement.panels.length < MAX_PANELS;
}

/**
 * A new panel of `kind` at the end of the board, or the hidden one shown
 * for a kind that can only be there once. Says which panel that is.
 */
export function addPanel(
  arrangement: HomeArrangement,
  kind: PanelKind,
  options: Pick<HomePanel, "playlist" | "period"> = {},
): { arrangement: HomeArrangement; id: HomePanelId | null } {
  const existing = allowsMany(kind) ? undefined : arrangement.panels.find((panel) => panel.kind === kind);
  if (existing) return { arrangement: setPanelHidden(arrangement, existing.id, false), id: existing.id };
  if (!canAdd(arrangement, kind)) return { arrangement, id: null };
  const panel = { ...newPanel(kind, freeId(kind, new Set(arrangement.panels.map((p) => p.id)))), ...options };
  return { arrangement: { panels: [...arrangement.panels, panel] }, id: panel.id };
}

export function removePanel(arrangement: HomeArrangement, id: HomePanelId): HomeArrangement {
  return { panels: arrangement.panels.filter((panel) => panel.id !== id) };
}

/** A panel's title: its own name, a playlist's name, or its kind's title. */
export function panelTitle(panel: HomePanel, playlists?: readonly { id: string; name: string }[] | null): string {
  if (panel.title) return panel.title;
  if (panel.kind === "playlist") return playlists?.find((p) => p.id === panel.playlist)?.name ?? PANEL_KINDS.playlist.title;
  return PANEL_KINDS[panel.kind].title;
}
