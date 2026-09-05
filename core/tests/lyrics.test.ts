import { describe, expect, it } from "vitest";
import {
  activeLineIndex,
  activeWordIndexForLine,
  parsePlainLyrics,
  parseSyncedLyrics,
} from "../src/lyrics";

describe("lyrics", () => {
  it("parses repeated timestamps, fractions, and section labels in time order", () => {
    expect(
      parseSyncedLyrics(
        "[ar:Artist]\n[01:02.34][00:01.5] Hello \n[00:02.003][Chorus]\n[00:03.0]   ",
      ),
    ).toEqual([
      { time: 1.5, text: "Hello", section: false },
      { time: 2.003, text: "[Chorus]", section: true },
      { time: 62.34, text: "Hello", section: false },
    ]);
    expect(parseSyncedLyrics(null)).toEqual([]);
    expect(parsePlainLyrics("\n [Verse] \n Hello \n\n")).toEqual([
      { text: "[Verse]", section: true },
      { text: "Hello", section: false },
    ]);
  });

  it("selects the last timestamp reached, including ties and backwards seeks", () => {
    const lines = parseSyncedLyrics("[00:01]A\n[00:02]B\n[00:02]C");
    expect(activeLineIndex(lines, 0)).toBe(-1);
    expect(activeLineIndex(lines, 2)).toBe(2);
    expect(activeLineIndex(lines, 100)).toBe(2);
    expect(activeLineIndex(lines, 1)).toBe(0);
    expect(activeLineIndex([], 10)).toBe(-1);
  });

  it("weights word timing by length and constrains time before/after the line", () => {
    const line = { time: 10, text: "a longer", section: false };
    const next = { ...line, time: 14 };
    expect(activeWordIndexForLine(line, next, 0, 30)).toBe(0);
    expect(activeWordIndexForLine(line, next, 10.5, 30)).toBe(0);
    expect(activeWordIndexForLine(line, next, 11, 30)).toBe(1);
    expect(activeWordIndexForLine(line, next, 100, 30)).toBe(1);
    expect(
      activeWordIndexForLine({ ...line, text: " " }, next, 11, 30),
    ).toBeNull();
  });

  it("handles final lines, punctuation, Unicode, and overlapping timestamps", () => {
    const line = { time: 10, text: "你好 !!!", section: false };
    expect(activeWordIndexForLine(line, undefined, 100, 11)).toBe(1);
    expect(activeWordIndexForLine(line, { ...line }, 10.2, 10)).toBe(1);
  });
});
