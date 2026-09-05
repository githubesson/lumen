import { describe, expect, it } from "vitest";
import {
  adjustSnippetWindow,
  normalizeSnippetSelection,
  snippetHandleBounds,
  snippetWindow,
} from "../src/share-snippet";

describe("share snippet selection", () => {
  it("handles unknown, short, fractional, and long tracks", () => {
    expect(snippetWindow(0, 30, 0)).toMatchObject({
      maxDurationSec: 30,
      effectiveDurationSec: 30,
      maxStartSec: 0,
    });
    expect(snippetWindow(2.3, 30, 0)).toMatchObject({
      minDurationSec: 3,
      maxDurationSec: 3,
      endSec: 2.3,
      displayDurationSec: 2.3,
    });
    expect(snippetWindow(300, 200, 0)).toMatchObject({
      effectiveDurationSec: 120,
      maxStartSec: 180,
    });
  });
  it("rounds selections and keeps them within the track", () => {
    expect(normalizeSnippetSelection(60.8, 100, 30.4)).toEqual({
      startSec: 30,
      durationSec: 30,
    });
    expect(normalizeSnippetSelection(60, -5, 1)).toEqual({
      startSec: 0,
      durationSec: 5,
    });
    expect(normalizeSnippetSelection(0.4, 5, 10)).toEqual({
      startSec: 0,
      durationSec: 1,
    });
  });
  const bounds = {
    durationSec: 200,
    startSec: 50,
    endSec: 80,
    minDurationSec: 5,
    maxDurationSec: 120,
    maxStartSec: 170,
  };
  it("constrains each edge and preserves duration when moving the window", () => {
    expect(
      adjustSnippetWindow({ ...bounds, kind: "start", atSec: 100 }),
    ).toEqual({ startSec: 75, durationSec: 5 });
    expect(adjustSnippetWindow({ ...bounds, kind: "end", atSec: 500 })).toEqual(
      { startSec: 50, durationSec: 120 },
    );
    expect(
      adjustSnippetWindow({ ...bounds, kind: "window", atSec: 500 }),
    ).toEqual({ startSec: 170, durationSec: 30 });
  });
  it("keeps a short track's fractional end available to all input methods", () => {
    const short = {
      ...bounds,
      durationSec: 2.3,
      startSec: 0,
      endSec: 2.3,
      minDurationSec: 3,
      maxDurationSec: 3,
      maxStartSec: 0,
    };
    expect(snippetHandleBounds(short)).toEqual({
      minStartSec: 0,
      maxStartSec: 0,
      minEndSec: 2.3,
      maxEndSec: 2.3,
    });
    expect(adjustSnippetWindow({ ...short, kind: "end", atSec: 10 })).toEqual({
      startSec: 0,
      durationSec: 2.3,
    });
  });
});
