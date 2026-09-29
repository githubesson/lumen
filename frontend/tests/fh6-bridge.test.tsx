import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FH6Snapshot } from "../src/lib/fh6";
import { useFH6Bridge } from "../src/pages/fh6/useFH6Bridge";

const BRIDGE = "http://bridge.test";

let bridgeDown = false;
let payload: Record<string, unknown>;
let events: Array<FH6Snapshot | null>;
const onSnapshot = (event: Event) => {
  events.push((event as CustomEvent<FH6Snapshot | null>).detail);
};

beforeEach(() => {
  bridgeDown = false;
  events = [];
  payload = {
    "/api/state": {
      sources: { active: "lumen", available: [{ name: "lumen", playback_state: "paused" }] },
      track: { title: "One", artist: "A", duration_ms: 200_000, position_ms: 1_000 },
    },
    "/api/config": { lumen: { queue_mode: "tracks", limit: 1000 } },
    "/api/source/lumen/queue": {
      tracks: Array.from({ length: 300 }, (_, i) => ({ id: `t${i}`, title: `Track ${i}` })),
      current_index: 0,
    },
  };
  // Every poll parses a fresh copy, as the real bridge responses would.
  vi.stubGlobal("fetch", async (url: string) => {
    if (bridgeDown) throw new TypeError("Failed to fetch");
    const body = JSON.stringify(payload[url.slice(BRIDGE.length)]);
    return { ok: true, json: async () => JSON.parse(body) } as Response;
  });
  window.addEventListener("lumen:fh6-radio-state", onSnapshot);
});

afterEach(() => {
  cleanup();
  window.removeEventListener("lumen:fh6-radio-state", onSnapshot);
  vi.unstubAllGlobals();
});

function renderBridge() {
  let renders = 0;
  const setError = vi.fn();
  const hook = renderHook(() => {
    renders += 1;
    return useFH6Bridge(BRIDGE, setError);
  });
  return { ...hook, renders: () => renders };
}

it("sets and publishes nothing when a poll brings nothing new", async () => {
  const { result, renders } = renderBridge();
  await act(() => result.current.refreshBridge(false));
  expect(events).toHaveLength(1);
  expect(result.current.queue).toHaveLength(300);
  const first = result.current;
  const rendersAfterFirst = renders();

  await act(() => result.current.refreshBridge(false));
  await act(() => result.current.refreshBridge(false));

  expect(events).toHaveLength(1);
  expect(renders()).toBe(rendersAfterFirst);
  expect(result.current.state).toBe(first.state);
  expect(result.current.config).toBe(first.config);
  expect(result.current.queue).toBe(first.queue);
  expect(result.current.sourceDraft).toBe(first.sourceDraft);
});

it("publishes a moved position without handing over a new queue", async () => {
  const { result } = renderBridge();
  await act(() => result.current.refreshBridge(false));
  const first = result.current;

  (payload["/api/state"] as { track: { position_ms: number } }).track.position_ms = 3_500;
  await act(() => result.current.refreshBridge(false));

  expect(events).toHaveLength(2);
  expect(result.current.state).not.toBe(first.state);
  expect(result.current.state?.track?.position_ms).toBe(3_500);
  expect(result.current.queue).toBe(first.queue);
  expect(result.current.config).toBe(first.config);
  expect(events[1]?.queue).toBe(events[0]?.queue);
});

it("picks up a change in the middle of the queue", async () => {
  const { result } = renderBridge();
  await act(() => result.current.refreshBridge(false));
  const first = result.current;

  const queue = payload["/api/source/lumen/queue"] as { tracks: { title: string }[] };
  queue.tracks[150].title = "Renamed";
  await act(() => result.current.refreshBridge(false));

  expect(events).toHaveLength(2);
  expect(result.current.queue).not.toBe(first.queue);
  expect(result.current.queue[150].title).toBe("Renamed");
  expect(result.current.state).toBe(first.state);
});

it("publishes a bridge that stays down once, and its return", async () => {
  const { result } = renderBridge();
  await act(() => result.current.refreshBridge(false));
  bridgeDown = true;
  await act(() => result.current.refreshBridge(false));
  await act(() => result.current.refreshBridge(false));

  expect(events).toHaveLength(2);
  expect(events[1]?.state).toBeNull();
  expect(result.current.state).toBeNull();

  bridgeDown = false;
  await act(() => result.current.refreshBridge(false));
  expect(events).toHaveLength(3);
  expect(events[2]?.state).not.toBeNull();
  expect(events[2]?.queue).toHaveLength(300);
});

it("resets an applied draft to the config the bridge kept", async () => {
  const { result } = renderBridge();
  await act(() => result.current.refreshBridge(false));

  // The page clamps the limit to 1,000 before sending it, so the bridge's
  // config doesn't change; the draft still has to drop the 5,000.
  act(() => {
    result.current.updateSourceDraft({ limit: 5000 });
  });
  act(() => result.current.markSourceApplied());
  await act(() => result.current.refreshBridge(false));

  expect(result.current.sourceDraft.limit).toBe(1000);
});
