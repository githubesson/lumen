// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mint = vi.hoisted(() => vi.fn());
vi.mock("../src/api-media", async (original) => ({
  ...(await original<typeof import("../src/api-media")>()),
  createTrackShareLink: mint,
}));

import { useShareLinkSession } from "../src/share-link-session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  mint.mockReset();
});

describe("useShareLinkSession", () => {
  it("mints once per window and reuses the link", async () => {
    mint.mockResolvedValue({ url: "https://l/s/1" });
    const { result } = renderHook(() => useShareLinkSession());
    let first = "";
    let second = "";
    await act(async () => {
      first = await result.current.ensureUrl("t1", 10, 30);
      second = await result.current.ensureUrl("t1", 10, 30);
    });
    expect(first).toBe("https://l/s/1");
    expect(second).toBe("https://l/s/1");
    expect(mint).toHaveBeenCalledTimes(1);
    expect(result.current.shareUrl).toBe("https://l/s/1");
  });

  it("shares one mint between concurrent requests for the same window", async () => {
    const pending = deferred<{ url: string }>();
    mint.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useShareLinkSession());
    let a!: Promise<string>;
    let b!: Promise<string>;
    act(() => {
      a = result.current.ensureUrl("t1", 0, 30);
      b = result.current.ensureUrl("t1", 0, 30);
    });
    await act(async () => pending.resolve({ url: "u" }));
    await expect(a).resolves.toBe("u");
    await expect(b).resolves.toBe("u");
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("mints again for a moved window and clears the shown link on invalidate", async () => {
    mint.mockResolvedValueOnce({ url: "old" }).mockResolvedValueOnce({ url: "new" });
    const { result } = renderHook(() => useShareLinkSession());
    await act(async () => {
      await result.current.ensureUrl("t1", 0, 30);
    });
    act(() => result.current.invalidate());
    expect(result.current.shareUrl).toBeNull();
    await act(async () => {
      await result.current.ensureUrl("t1", 5, 30);
    });
    expect(result.current.shareUrl).toBe("new");
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("never shows a link that lands after its window moved", async () => {
    const stale = deferred<{ url: string }>();
    mint.mockReturnValueOnce(stale.promise).mockResolvedValueOnce({ url: "fresh" });
    const { result } = renderHook(() => useShareLinkSession());
    let staleUrl!: Promise<string>;
    act(() => {
      staleUrl = result.current.ensureUrl("t1", 0, 30);
    });
    act(() => result.current.invalidate());
    await act(async () => {
      await result.current.ensureUrl("t1", 5, 30);
    });
    await act(async () => stale.resolve({ url: "stale" }));
    // The caller that asked for the old window still gets its link...
    await expect(staleUrl).resolves.toBe("stale");
    // ...but the session shows the current window's.
    expect(result.current.shareUrl).toBe("fresh");
  });

  it("forgets a failed mint so the next attempt retries", async () => {
    mint.mockRejectedValueOnce(new Error("nope")).mockResolvedValueOnce({ url: "u" });
    const { result } = renderHook(() => useShareLinkSession());
    await act(async () => {
      await expect(result.current.ensureUrl("t1", 0, 30)).rejects.toThrow("nope");
    });
    expect(result.current.shareUrl).toBeNull();
    await act(async () => {
      await expect(result.current.ensureUrl("t1", 0, 30)).resolves.toBe("u");
    });
    expect(mint).toHaveBeenCalledTimes(2);
  });
});
