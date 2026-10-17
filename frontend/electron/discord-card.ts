import type { DiscordCardOptions } from "../src/contracts/desktop";

// How the Discord card reads, shared by the main process (which sends the
// activity) and the renderer's Settings preview, so the preview shows what
// Discord will. No Node or DOM imports: this compiles into both.

export const DEFAULT_DISCORD_CARD: DiscordCardOptions = {
  details: "{title}",
  state: "{artist}",
  largeText: "{album}",
  statusName: "app",
  cover: true,
  playState: true,
  showPaused: true,
};

/** Longest template kept; Discord cuts each line at 128 characters anyway. */
const MAX_TEMPLATE = 128;

/** Fill in defaults and drop anything malformed, e.g. from a hand-edited config. */
export function normalizeDiscordCard(raw: unknown): DiscordCardOptions {
  const value = raw && typeof raw === "object" ? (raw as Partial<Record<keyof DiscordCardOptions, unknown>>) : {};
  const text = (v: unknown, fallback: string) => (typeof v === "string" ? v.slice(0, MAX_TEMPLATE) : fallback);
  const flag = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const d = DEFAULT_DISCORD_CARD;
  return {
    details: text(value.details, d.details),
    state: text(value.state, d.state),
    largeText: text(value.largeText, d.largeText),
    statusName:
      value.statusName === "details" || value.statusName === "state" ? value.statusName : d.statusName,
    cover: flag(value.cover, d.cover),
    playState: flag(value.playState, d.playState),
    showPaused: flag(value.showPaused, d.showPaused),
  };
}

export interface DiscordCardFields {
  title?: string;
  artist?: string;
  album?: string;
}

/**
 * Discord wants 2–128 characters per line: a single character (one emoji
 * included) is padded, and a cut never splits an emoji's surrogate pair.
 */
export function clampForDiscord(value: string | undefined, max = 128): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (Array.from(trimmed).length < 2) return `${trimmed} `;
  return trimmed.slice(0, max).replace(/[\ud800-\udbff]$/, "");
}

const TOKEN = /(\{(?:title|artist|album)\})/i;
// Text between fields that only joins them, dropped along with a missing field.
const JOINER = /^[\s\-–—·•|,:/~+&]*$/;

/**
 * Fill {title}, {artist} and {album} into a line's template. A missing field
 * takes the joiner beside it along ("{artist} · {album}" with no album reads
 * "beansclub"), and a line whose fields are all missing is hidden.
 */
export function fillDiscordTemplate(template: string, fields: DiscordCardFields): string | undefined {
  // Odd indexes are the tokens, even ones the text around them.
  const parts = template.split(TOKEN);
  let tokens = 0;
  let filled = 0;
  let textBefore = false;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (!JOINER.test(parts[i])) textBefore = true;
      continue;
    }
    tokens += 1;
    const key = parts[i].slice(1, -1).toLowerCase() as keyof DiscordCardFields;
    const value = fields[key]?.trim();
    if (value) {
      parts[i] = value;
      filled += 1;
      textBefore = true;
      continue;
    }
    parts[i] = "";
    if (textBefore) {
      if (JOINER.test(parts[i - 1])) parts[i - 1] = "";
    } else if (i + 1 < parts.length && JOINER.test(parts[i + 1])) {
      parts[i + 1] = "";
    }
  }
  if (tokens > 0 && filled === 0) return undefined;
  const line = parts
    .join("")
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/\s+/g, " ");
  return clampForDiscord(line);
}

/** The card's three lines for a track; undefined hides a line. */
export function discordCardLines(card: DiscordCardOptions, fields: DiscordCardFields) {
  return {
    details: fillDiscordTemplate(card.details, fields),
    state: fillDiscordTemplate(card.state, fields),
    largeText: fillDiscordTemplate(card.largeText, fields),
  };
}

/** Discord's `status_display_type`: 0 shows the app's name, 1 the state, 2 the details. */
export function discordStatusDisplayType(card: DiscordCardOptions): 0 | 1 | 2 {
  return card.statusName === "state" ? 1 : card.statusName === "details" ? 2 : 0;
}
