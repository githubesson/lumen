import { expect, it } from "vitest";
import { fitItems, type FillMetrics } from "../src/components/home/useBoardFill";

const rows = (metrics: Partial<FillMetrics>): FillMetrics => ({
  height: 260, columns: 1, row: 52, gap: 0, margins: 0, items: 20, ...metrics,
});
const covers = (columns: number) => Math.max(4, columns);

it("keeps the usual rows when the slot has no room to spare", () => {
  expect(fitItems(5, rows({ height: 260 }))).toEqual({ count: 5, minHeight: 260 });
  // A fraction of a row short is still no room.
  expect(fitItems(5, rows({ height: 311 }))).toEqual({ count: 5, minHeight: 260 });
});

it("fills a taller slot with whole rows", () => {
  expect(fitItems(5, rows({ height: 312 })).count).toBe(6);
  expect(fitItems(5, rows({ height: 700 })).count).toBe(13);
  // Its own height still counts only the usual rows.
  expect(fitItems(5, rows({ height: 700 })).minHeight).toBe(260);
});

it("fills the last row of a two-column list", () => {
  // Five rows usually: three rows of two, the last one half empty.
  expect(fitItems(5, rows({ columns: 2, height: 156 }))).toEqual({ count: 6, minHeight: 156 });
});

it("counts only the items there are toward its height", () => {
  expect(fitItems(5, rows({ items: 3, height: 156 }))).toEqual({ count: 5, minHeight: 156 });
  expect(fitItems(5, rows({ items: 0, height: 0 }))).toEqual({ count: 5, minHeight: 0 });
});

it("fills a row of covers, and at least four", () => {
  const grid = { row: 200, gap: 4, margins: -4, items: 12 };
  expect(fitItems(covers, rows({ ...grid, columns: 6, height: 196 }))).toEqual({ count: 6, minHeight: 196 });
  expect(fitItems(covers, rows({ ...grid, columns: 2, height: 400 }))).toEqual({ count: 4, minHeight: 400 });
  // Room for a second row of four.
  expect(fitItems(covers, rows({ ...grid, columns: 4, height: 400 })).count).toBe(8);
});

it("shows nothing it wasn't asked to until a row fits", () => {
  // Jump back in's tracks: none usually, with a 12px margin above them.
  const tracks = { margins: 12, items: 0 };
  expect(fitItems(0, rows({ ...tracks, height: 60 }))).toEqual({ count: 0, minHeight: 0 });
  expect(fitItems(0, rows({ ...tracks, height: 64 }))).toEqual({ count: 1, minHeight: 0 });
  expect(fitItems(0, rows({ ...tracks, height: 200 })).count).toBe(3);
});

it("counts no room past a min-height of its own, which may be out of date", () => {
  // Two rows of narrow covers held the area at 455px; at four columns the
  // covers are smaller and one row (124px) is the usual height now.
  const covers4 = { columns: 4, row: 128, gap: 4, margins: -4, items: 4 };
  expect(fitItems(covers, rows({ ...covers4, height: 455, heldAt: 455 }))).toEqual({ count: 4, minHeight: 124 });
  // Taller than its min-height, the slot is giving it room: that counts.
  expect(fitItems(covers, rows({ ...covers4, height: 455, heldAt: 124 })).count).toBe(12);
  // Still the tallest in its row: the usual rows, as before.
  expect(fitItems(5, rows({ height: 260, heldAt: 260 }))).toEqual({ count: 5, minHeight: 260 });
});
