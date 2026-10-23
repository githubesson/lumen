import { describe, expect, it } from "vitest";
import {
  FOLD,
  actionsOffset,
  coverFrame,
  foldOpacity,
  trackInfoFold,
} from "../lib/track-info-fold";

// An iPhone 15: 393 wide, a 98-high nav bar (status bar + 44), as the mock.
const phone = trackInfoFold(393, 98, false);

/** Where the scaled cover shows: its top-left and size on screen. */
function shownCover(s: number, fold = phone) {
  const frame = coverFrame(s, fold);
  const size = fold.cover * frame.scale;
  const grow = (fold.cover - size) / 2;
  return {
    left: fold.left + FOLD.side + frame.translateX + grow,
    top: fold.top + FOLD.coverTop + frame.translateY + grow,
    size,
    radius: frame.borderRadius * frame.scale,
  };
}

describe("trackInfoFold", () => {
  it("matches the mock's geometry on a phone", () => {
    expect(phone).toMatchObject({ column: 393, left: 0, cover: 337, fold: 279, spacer: 360 });
    // The buttons sit centered on the 52-high title row, 15 under the cover…
    expect(phone.actionsTop).toBe(98 + 360 + 8);
    // …and stop centered on the compact row, 2 under the nav bar.
    expect(phone.actionsTop - phone.stick).toBe(98 + 2 + (58 - 36) / 2);
    expect(phone.stick).toBe(355);
    expect(phone.pin).toBe(279 + 35);
  });

  it("follows the measured title row", () => {
    // Bigger text makes the title row taller; the buttons stay centered on it.
    const tall = trackInfoFold(393, 98, false, { y: 360, height: 80 });
    expect(tall.actionsTop).toBe(98 + 360 + (80 - 36) / 2);
    expect(tall.stick).toBe(phone.stick + 14);
  });

  it("centers a column on a wide screen, the cover capped", () => {
    const pad = trackInfoFold(1024, 74, false);
    expect(pad).toMatchObject({ column: 600, left: 212, cover: 420 });
  });

  it("swaps at the stick without the fold", () => {
    expect(trackInfoFold(393, 98, true).pin).toBe(355);
  });
});

describe("coverFrame", () => {
  it("starts as the hero cover", () => {
    expect(shownCover(0)).toEqual({ left: 28, top: 106, size: 337, radius: 12 });
  });

  it("folds into the compact cover and stays there", () => {
    for (const s of [phone.fold, phone.fold + 200]) {
      const cover = shownCover(s);
      expect(cover.left).toBeCloseTo(16);
      expect(cover.top).toBeCloseTo(100);
      expect(cover.size).toBeCloseTo(58);
      expect(cover.radius).toBeCloseTo(8);
    }
  });

  it("keeps its bottom riding the content as it shrinks", () => {
    // Halfway, it has shrunk by as much as the content moved, give or take
    // the few points it climbs to the compact row's top.
    const half = shownCover(phone.fold / 2);
    expect(half.size).toBeCloseTo(337 - phone.fold / 2);
    expect(half.top + half.size).toBeCloseTo(106 + 337 - phone.fold / 2 - 3);
  });

  it("follows the content when pulled down past the top", () => {
    expect(shownCover(-40)).toEqual({ left: 28, top: 146, size: 337, radius: 12 });
  });
});

describe("actionsOffset", () => {
  it("scrolls with the title row, then stays beside the compact row", () => {
    expect(actionsOffset(0, phone).translateX).toBe(0);
    expect(actionsOffset(0, phone).translateY).toBeCloseTo(0);
    expect(actionsOffset(100, phone)).toEqual({ translateX: 0, translateY: -100 });
    expect(actionsOffset(phone.stick, phone)).toEqual({ translateX: 12, translateY: -355 });
    expect(actionsOffset(900, phone)).toEqual({ translateX: 12, translateY: -355 });
    // Pulled down, it follows the content too.
    expect(actionsOffset(-20, phone).translateY).toBe(20);
  });

  it("steps to the compact row's padding without the fold", () => {
    const still = trackInfoFold(393, 98, true);
    expect(actionsOffset(still.stick - 1, still).translateX).toBe(0);
    expect(actionsOffset(still.stick, still).translateX).toBe(12);
  });
});

describe("foldOpacity", () => {
  it("fades the hero out as the compact row fades in", () => {
    expect(foldOpacity(0, phone)).toEqual({ compact: 0, backdrop: 0, meta: 1, album: 1 });
    expect(foldOpacity(phone.fold + 70, phone)).toEqual({ compact: 1, backdrop: 1, meta: 0, album: 0 });
    expect(foldOpacity(phone.fold + 35, phone).compact).toBeCloseTo(0.5);
  });

  it("swaps without fading when motion is reduced", () => {
    const still = trackInfoFold(393, 98, true);
    expect(foldOpacity(still.pin - 1, still)).toEqual({ compact: 0, backdrop: 0, meta: 1, album: 1 });
    expect(foldOpacity(still.pin, still)).toEqual({ compact: 1, backdrop: 1, meta: 1, album: 1 });
  });
});
