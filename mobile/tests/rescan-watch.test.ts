import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import { libraryChanged, type RescanStatus } from "@music-library/core";
import { followRescan, rescanStatusQuery } from "../lib/rescan-watch";

function client(fetchQuery: () => Promise<RescanStatus>) {
  return { fetchQuery: vi.fn(fetchQuery), resetQueries: vi.fn() };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

it("drops the cached status after reads keep failing, so the spinner clears", async () => {
  const qc = client(() => Promise.reject(new Error("offline")));
  followRescan(qc as unknown as QueryClient);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(qc.fetchQuery).toHaveBeenCalledTimes(5);
  expect(qc.resetQueries).toHaveBeenCalledWith({ queryKey: rescanStatusQuery.queryKey });

  // The watcher is free again for the next scan.
  const next = client(() => Promise.resolve({ running: false }));
  followRescan(next as unknown as QueryClient);
  await vi.advanceTimersByTimeAsync(0);
  expect(next.fetchQuery).toHaveBeenCalledTimes(1);
});

it("announces a library change once a scan that did work finishes", async () => {
  const changed = vi.fn();
  const stop = libraryChanged.on(changed);
  const qc = client(() => Promise.resolve({ running: false, processed: 3, inserted: 1 }));
  followRescan(qc as unknown as QueryClient);
  await vi.advanceTimersByTimeAsync(0);
  stop();
  expect(changed).toHaveBeenCalledTimes(1);
  expect(qc.resetQueries).not.toHaveBeenCalled();
});
