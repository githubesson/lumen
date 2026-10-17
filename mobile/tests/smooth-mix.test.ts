import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  // Resolves the pending read, so a test can act while it is in flight.
  release: null as (() => void) | null,
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) =>
      new Promise<string | null>((resolve) => {
        h.release = () => resolve(h.kv.get(key) ?? null);
      }),
    setItem: async (key: string, value: string) => {
      h.kv.set(key, value);
    },
  },
}));

const KEY = "smooth-mix.seconds.v1";

async function freshStore() {
  vi.resetModules();
  return (await import("../lib/smooth-mix")).smoothMixStore;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  h.kv.clear();
  h.release = null;
});

describe("smoothMixStore", () => {
  it("loads the saved length when first subscribed, and saves changes", async () => {
    h.kv.set(KEY, "6");
    const store = await freshStore();
    expect(store.get()).toBe(0);
    const listener = vi.fn();
    store.subscribe(listener);
    h.release?.();
    await flush();
    expect(store.get()).toBe(6);
    expect(listener).toHaveBeenCalledOnce();

    store.set(0);
    expect(store.get()).toBe(0);
    expect(h.kv.get(KEY)).toBe("0");
  });

  it("keeps a choice made while the saved one was still loading", async () => {
    h.kv.set(KEY, "12");
    const store = await freshStore();
    store.subscribe(() => {});
    store.set(3);
    h.release?.();
    await flush();
    expect(store.get()).toBe(3);
  });

  it("ignores a saved value that isn't a length", async () => {
    h.kv.set(KEY, "soon");
    const store = await freshStore();
    store.subscribe(() => {});
    h.release?.();
    await flush();
    expect(store.get()).toBe(0);
  });
});
