import { afterEach, expect, it, vi } from "vitest";
import { lazyChunk, openWhenLoaded } from "../src/lib/lazyChunk";

afterEach(() => { vi.restoreAllMocks(); });

function deferredChunk() {
  let resolve!: () => void;
  const importer = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
  return { chunk: lazyChunk(importer), importer, resolve: () => resolve() };
}

it("opens once the chunk loads, and straight away after that", async () => {
  const { chunk, importer, resolve } = deferredChunk();
  const commit = vi.fn();
  openWhenLoaded(chunk, commit);
  expect(commit).not.toHaveBeenCalled();
  resolve();
  await chunk.load();
  expect(commit).toHaveBeenCalledOnce();
  openWhenLoaded(chunk, commit);
  expect(commit).toHaveBeenCalledTimes(2);
  expect(importer).toHaveBeenCalledOnce();
});

it.each([
  ["Escape", () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))],
  ["a pointer press", () => window.dispatchEvent(new Event("pointerdown"))],
  ["window blur", () => window.dispatchEvent(new Event("blur"))],
  ["cancel()", (cancel: () => void) => cancel()],
])("drops an open dismissed by %s while the chunk loads", async (_, dismiss) => {
  const { chunk, resolve } = deferredChunk();
  const commit = vi.fn();
  const cancel = openWhenLoaded(chunk, commit);
  dismiss(cancel);
  expect(cancel()).toBe(false);
  resolve();
  await chunk.load();
  expect(commit).not.toHaveBeenCalled();
});

it("ignores other keys while loading", async () => {
  const { chunk, resolve } = deferredChunk();
  const commit = vi.fn();
  openWhenLoaded(chunk, commit);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
  resolve();
  await chunk.load();
  expect(commit).toHaveBeenCalledOnce();
});

it("retries the import after a failed load", async () => {
  const importer = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({});
  const chunk = lazyChunk(importer);
  await expect(chunk.load()).rejects.toThrow("offline");
  await chunk.load();
  expect(chunk.loaded).toBe(true);
  expect(importer).toHaveBeenCalledTimes(2);
});

it("reports whether cancelling stopped a pending open", async () => {
  const { chunk, resolve } = deferredChunk();
  const cancel = openWhenLoaded(chunk, vi.fn());
  expect(cancel()).toBe(true);
  expect(cancel()).toBe(false);
  resolve();
  await chunk.load();
  expect(openWhenLoaded(chunk, vi.fn())()).toBe(false);
});
