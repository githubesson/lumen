import { act, cleanup, renderHook } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { usePaginatedList } from "../src/lib/usePaginatedList";
import { libraryChanged } from "../src/lib/events";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("prefetches within the scroll container and retains loaded pages on background refresh", async () => {
  let observe!: IntersectionObserverCallback;
  let options!: IntersectionObserverInit;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback, init: IntersectionObserverInit) { observe = callback; options = init; }
    observe() {}
    disconnect() {}
  });
  const scroll = document.createElement("div");
  scroll.style.overflowY = "auto";
  const sentinel = document.createElement("div");
  scroll.append(sentinel);
  document.body.append(scroll);
  const all = Array.from({ length: 6 }, (_, index) => ({ id: String(index), title: "Song" }));
  const fetcher = vi.fn(async ({ offset, limit }: { offset: number; limit: number }) => ({ items: all.slice(offset, offset + limit).map((item) => ({ ...item })), total: all.length }));
  const { result } = renderHook(() => {
    const list = usePaginatedList(fetcher, "", { pageSize: 2 });
    useLayoutEffect(() => { list.sentinelRef.current = sentinel; }, [list.sentinelRef]);
    return list;
  });
  await act(async () => {});
  expect(options.root).toBe(scroll);
  expect(options.rootMargin).toBe("600px 0px");
  await act(async () => { observe([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver); });
  expect(result.current.items).toHaveLength(4);
  const previous = result.current.items;
  await act(async () => { libraryChanged.emit(); });
  expect(result.current.items).toBe(previous);
  expect(fetcher.mock.calls.map(([request]) => [request.offset, request.limit])).toEqual([[0, 2], [2, 2], [0, 4]]);
  scroll.remove();
});
