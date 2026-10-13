import { afterEach, describe, expect, it, vi } from "vitest";
import type { MusicRoot, RescanStatus } from "../src/api";
import {
  addMusicRootInput,
  canManageMusicRoot,
  musicRootKey,
  musicRootName,
  musicRootRemoval,
  rescanChangedLibrary,
  rescanProgress,
  rootRemovalChangedLibrary,
  watchRescan,
} from "../src/admin/music-roots";

function root(overrides: Partial<MusicRoot> = {}): MusicRoot {
  return {
    id: "8d3c2a52-6c43-4c43-9d55-8d5b0f1f7e10",
    path: "/mnt/external/flac",
    label: "",
    enabled: true,
    primary: false,
    exists: true,
    ...overrides,
  };
}

// As GET /api/admin/library/roots returns MUSIC_PATH.
const primary = root({
  id: "",
  path: "/music",
  label: "Primary (MUSIC_PATH)",
  primary: true,
});

describe("music root display", () => {
  it("names the primary root, then labels, then the folder name", () => {
    expect(musicRootName(primary)).toBe("Primary");
    expect(musicRootName(root({ label: "External" }))).toBe("External");
    expect(musicRootName(root())).toBe("flac");
    expect(musicRootName(root({ path: "/mnt/external/flac/" }))).toBe("flac");
    expect(musicRootName(root({ path: "D:\\Music\\Lossless" }))).toBe("Lossless");
    expect(musicRootName(root({ path: "/" }))).toBe("/");
  });

  it("keys rows uniquely even though the primary root has no id", () => {
    const rows = [primary, root(), root({ id: "other", path: "/other" })];
    const keys = rows.map(musicRootKey);
    expect(new Set(keys).size).toBe(rows.length);
    expect(keys).not.toContain("");
    expect(musicRootKey(root())).toBe(root().id);
  });

  it("only lets a configured root be paused or removed", () => {
    expect(canManageMusicRoot(primary)).toBe(false);
    expect(canManageMusicRoot(root())).toBe(true);
    // An id-less row has nothing for the API to address.
    expect(canManageMusicRoot(root({ id: "" }))).toBe(false);
  });
});

describe("music root removal", () => {
  it("offers purging only for a root no other watched root covers", () => {
    expect(musicRootRemoval(root())).toEqual({ canPurge: true, coveredBy: null });
    expect(musicRootRemoval(root({ covered_by: "" }))).toEqual({
      canPurge: true,
      coveredBy: null,
    });
    expect(musicRootRemoval(root({ covered_by: "/music" }))).toEqual({
      canPurge: false,
      coveredBy: "/music",
    });
  });

  it("changes the library only when tracks were purged", () => {
    expect(rootRemovalChangedLibrary({ purged: true, deletedTracks: 3 })).toBe(true);
    expect(rootRemovalChangedLibrary({ purged: true, deletedTracks: 0 })).toBe(false);
    expect(
      rootRemovalChangedLibrary({ purged: true, deletedTracks: undefined }),
    ).toBe(false);
    expect(rootRemovalChangedLibrary({ purged: false, deletedTracks: 3 })).toBe(
      false,
    );
  });
});

describe("finished rescans", () => {
  it("changed the library when they went through or pruned files", () => {
    expect(rescanChangedLibrary({ running: false, processed: 10 })).toBe(true);
    expect(
      rescanChangedLibrary({ running: false, processed: 0, pruned: 2 }),
    ).toBe(true);
  });

  it("did not when they found nothing, are still running, or are unknown", () => {
    expect(rescanChangedLibrary({ running: false })).toBe(false);
    expect(
      rescanChangedLibrary({ running: false, processed: 0, pruned: 0 }),
    ).toBe(false);
    expect(rescanChangedLibrary({ running: true, processed: 10 })).toBe(false);
    expect(rescanChangedLibrary(null)).toBe(false);
    expect(rescanChangedLibrary(undefined)).toBe(false);
  });
});

describe("adding a root", () => {
  it("trims the path and omits a blank label", () => {
    expect(addMusicRootInput("  /mnt/flac ", "  ")).toEqual({ path: "/mnt/flac" });
    expect(addMusicRootInput("/mnt/flac", " External ")).toEqual({
      path: "/mnt/flac",
      label: "External",
    });
  });

  it("has nothing to send without a path", () => {
    expect(addMusicRootInput("   ", "External")).toBeNull();
  });
});

describe("rescanProgress", () => {
  it("counts a running scan's files and what came of them", () => {
    expect(
      rescanProgress({ running: true, total: 40, processed: 12, inserted: 3, dedup: 1, errored: 2 }),
    ).toEqual({
      count: "12 / 40",
      detail: "12 / 40 processed · 3 inserted · 1 deduped · 2 errors",
    });
    expect(rescanProgress({ running: true, errored: 1 })).toEqual({
      count: "0 / ?",
      detail: "0 / ? processed · 0 inserted · 0 deduped · 1 error",
    });
  });

  it("has nothing to show for an idle scan", () => {
    expect(rescanProgress({ running: false, processed: 4 })).toBeNull();
    expect(rescanProgress(null)).toBeNull();
    expect(rescanProgress(undefined)).toBeNull();
  });
});

describe("watchRescan", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const statuses = (...list: (RescanStatus | Error)[]) => {
    const fetchStatus = vi.fn<(signal?: AbortSignal) => Promise<RescanStatus>>();
    for (const item of list) {
      if (item instanceof Error) fetchStatus.mockRejectedValueOnce(item);
      else fetchStatus.mockResolvedValueOnce(item);
    }
    return fetchStatus;
  };

  it("reads at once, then each interval, and resolves with the finished status", async () => {
    vi.useFakeTimers();
    const done = { running: false, processed: 5 };
    const fetchStatus = statuses({ running: true, processed: 1 }, { running: true, processed: 3 }, done);
    const onStatus = vi.fn();
    const watch = watchRescan({ fetchStatus, onStatus, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1001);
    await expect(watch).resolves.toBe(done);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    expect(onStatus.mock.calls.map(([status]) => status.processed)).toEqual([1, 3, 5]);
  });

  it("gives up after too many failed reads in a row", async () => {
    vi.useFakeTimers();
    const fail = new Error("offline");
    const fetchStatus = statuses(fail, { running: true }, fail, fail, fail);
    const watch = watchRescan({ fetchStatus, maxFailures: 3 });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(watch).resolves.toBeNull();
    // The success in between reset the count.
    expect(fetchStatus).toHaveBeenCalledTimes(5);
  });

  it("skips reads while paused, without counting them as failures", async () => {
    vi.useFakeTimers();
    let paused = true;
    const fetchStatus = statuses({ running: false });
    const watch = watchRescan({ fetchStatus, isPaused: () => paused, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchStatus).not.toHaveBeenCalled();
    paused = false;
    await vi.advanceTimersByTimeAsync(1000);
    await expect(watch).resolves.toEqual({ running: false });
  });

  it("stops when aborted, cancelling the read in flight", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchStatus = vi.fn(
      (signal?: AbortSignal) =>
        new Promise<RescanStatus>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const onStatus = vi.fn();
    const watch = watchRescan({ fetchStatus, onStatus, signal: controller.signal });
    controller.abort();
    await expect(watch).resolves.toBeNull();
    expect(fetchStatus.mock.calls[0][0]).toBe(controller.signal);
    expect(onStatus).not.toHaveBeenCalled();

    const idle = new AbortController();
    const waiting = watchRescan({ fetchStatus: statuses({ running: true }), signal: idle.signal });
    await vi.advanceTimersByTimeAsync(0);
    idle.abort();
    await expect(waiting).resolves.toBeNull();
  });
});
