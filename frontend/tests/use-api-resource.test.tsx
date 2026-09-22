import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useApiResource } from "../src/lib/useApiResource";

afterEach(cleanup);

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
