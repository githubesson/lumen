import { expect, it } from "vitest";
import { DEFAULT_DISCORD_CARD, fillDiscordTemplate, normalizeDiscordCard } from "../electron/discord-card";

const track = { title: "look for me in heaven", artist: "beansclub", album: "NOTHING LEFT TO SAY" };

it("fills the track's fields into a line", () => {
  expect(fillDiscordTemplate("{title}", track)).toBe("look for me in heaven");
  expect(fillDiscordTemplate("{artist} · {album}", track)).toBe("beansclub · NOTHING LEFT TO SAY");
  expect(fillDiscordTemplate("by {ARTIST}", track)).toBe("by beansclub");
  expect(fillDiscordTemplate("on repeat", track)).toBe("on repeat");
});

it("drops a missing field with the joiner beside it", () => {
  const noAlbum = { title: "Song", artist: "Band" };
  expect(fillDiscordTemplate("{artist} · {album}", noAlbum)).toBe("Band");
  expect(fillDiscordTemplate("{album} — {artist}", noAlbum)).toBe("Band");
  expect(fillDiscordTemplate("{title} - {album} - {artist}", noAlbum)).toBe("Song - Band");
  expect(fillDiscordTemplate("{album} · {album} · {artist}", noAlbum)).toBe("Band");
  expect(fillDiscordTemplate("{title} ({album})", noAlbum)).toBe("Song");
});

it("hides a line that's empty or whose fields are all missing", () => {
  expect(fillDiscordTemplate("", track)).toBeUndefined();
  expect(fillDiscordTemplate("   ", track)).toBeUndefined();
  expect(fillDiscordTemplate("from {album}", { title: "Song" })).toBeUndefined();
});

it("keeps lines within Discord's 2–128 characters", () => {
  expect(fillDiscordTemplate("{title}", { title: "x" })).toBe("x ");
  expect(fillDiscordTemplate("{title}", { title: "🎧" })).toBe("🎧 ");
  expect(fillDiscordTemplate("{title}", { title: "a".repeat(200) })).toHaveLength(128);
  // A cut never leaves half of an emoji.
  expect(fillDiscordTemplate("{title}", { title: `${"a".repeat(127)}🎧` })).toBe("a".repeat(127));
});

it("reads saved options, falling back to the defaults for anything malformed", () => {
  expect(normalizeDiscordCard(undefined)).toEqual(DEFAULT_DISCORD_CARD);
  expect(normalizeDiscordCard({ details: "", statusName: "nope", cover: "yes", showPaused: false })).toEqual({
    ...DEFAULT_DISCORD_CARD,
    details: "",
    showPaused: false,
  });
});

it("takes options Settings didn't change, or sent malformed, from the saved card", () => {
  const saved = { ...DEFAULT_DISCORD_CARD, details: "{artist}", cover: false };
  expect(normalizeDiscordCard({ state: "from {album}" }, saved)).toEqual({ ...saved, state: "from {album}" });
  expect(normalizeDiscordCard({ statusName: "nope", playState: 0 }, saved)).toEqual(saved);
});
