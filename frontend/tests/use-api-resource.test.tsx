import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useApiResource } from "../src/lib/useApiResource";
import {
  claimResourceCache,
  clearResourceCache,
  readCache,
  writeCache,
} from "../src/lib/resourceCache";

afterEach(() => {
  cleanup();
  clearResourceCache();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

it("resolves reload() only after the refreshed data has arrived", async () => {
  const loads = [deferred<string>(), deferred<string>()];
  let call = 0;
  const { result } = renderHook(() => useApiResource(() => loads[call++].promise));

  await act(async () => { loads[0].resolve("stale"); });
  expect(result.current.data).toBe("stale");

  let settled = false;
  let reloading!: Promise<void>;
  act(() => { reloading = result.current.reload().then(() => { settled = true; }); });
  await waitFor(() => expect(call).toBe(2));
  expect(settled).toBe(false);
  expect(result.current.data).toBe("stale");

  await act(async () => { loads[1].resolve("fresh"); await reloading; });
  expect(settled).toBe(true);
  expect(result.current.data).toBe("fresh");
});

it("resolves reload() on failure and surfaces the error instead", async () => {
  const loads = [deferred<string>(), deferred<string>()];
  let call = 0;
  const { result } = renderHook(() =>
    useApiResource(() => loads[call++].promise, "Load failed."),
  );
  await act(async () => { loads[0].resolve("ok"); });

  let reloading!: Promise<void>;
  act(() => { reloading = result.current.reload(); });
  await waitFor(() => expect(call).toBe(2));
  await act(async () => { loads[1].reject(new Error("boom")); await reloading; });
  expect(result.current.error).toBeTruthy();
});

it("does not leave reload() pending when the owner unmounts mid-load", async () => {
  const pending = deferred<string>();
  const { result, unmount } = renderHook(() => useApiResource(() => pending.promise));
  let reloading!: Promise<void>;
  act(() => { reloading = result.current.reload(); });
  unmount();
  await expect(reloading).resolves.toBeUndefined();
});

it("starts a remount from the cached result and refreshes behind it", async () => {
  const loads = [deferred<string>(), deferred<string>()];
  let call = 0;
  const useCachedResource = () => useApiResource(() => loads[call++].promise, "x", { cacheKey: "k" });
  const first = renderHook(useCachedResource);
  expect(first.result.current.data).toBeNull();
  await act(async () => { loads[0].resolve("first"); });
  first.unmount();

  const second = renderHook(useCachedResource);
  expect(second.result.current.data).toBe("first");
  expect(second.result.current.loading).toBe(true);
  await act(async () => { loads[1].resolve("second"); });
  expect(second.result.current.data).toBe("second");
  expect(second.result.current.loading).toBe(false);
});

it("drops the cache when another account claims it, and keeps it for the same one", () => {
  claimResourceCache("a");
  writeCache("k", "a's data");
  claimResourceCache("a");
  expect(readCache("k")).toBe("a's data");
  claimResourceCache("b");
  expect(readCache("k")).toBeUndefined();
});

it("drops a read that started before update() and still settles its reload", async () => {
  const pending = deferred<string[]>();
  const { result } = renderHook(() => useApiResource(() => pending.promise));
  act(() => { result.current.update(() => ["kept"]); });
  await act(async () => { pending.resolve(["stale"]); });
  expect(result.current.data).toEqual(["kept"]);
  expect(result.current.loading).toBe(false);
});
