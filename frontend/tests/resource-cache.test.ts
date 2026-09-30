import { afterEach, expect, it } from "vitest";
import { clearResourceCache, dropCache, readCache, writeCache } from "../src/lib/resourceCache";

afterEach(clearResourceCache);

it("evicts the least recently used resource after 100 entries", () => {
  for (let i = 0; i < 100; i++) writeCache(`resource:${i}`, i);
  expect(readCache("resource:0")).toBe(0);
  writeCache("resource:100", 100);
  expect(readCache("resource:1")).toBeUndefined();
  expect(readCache("resource:0")).toBe(0);
  expect(readCache("resource:100")).toBe(100);
});

it("refreshes an overwritten resource without evicting another entry", () => {
  for (let i = 0; i < 100; i++) writeCache(`resource:${i}`, i);
  writeCache("resource:0", "updated");
  expect(readCache("resource:1")).toBe(1);
  writeCache("resource:100", 100);
  expect(readCache("resource:2")).toBeUndefined();
  expect(readCache("resource:0")).toBe("updated");
});

it("releases removed resources, including an update that clears its value", () => {
  writeCache("removed", ["track"]);
  writeCache("cleared", ["track"]);
  dropCache("removed");
  writeCache("cleared", undefined);
  expect(readCache("removed")).toBeUndefined();
  expect(readCache("cleared")).toBeUndefined();
});
