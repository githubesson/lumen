/**
 * Owner-accounting tests for the offline download store. The native layers
 * (expo-file-system, background-downloader, cookies, AsyncStorage) are
 * faked in-memory; the store itself is the real module under test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Shared fake state (hoisted so vi.mock factories can read it) ────────────
const h = vi.hoisted(() => {
  interface FakeTask {
    id: string;
    metadata?: { owners?: string[]; track?: unknown };
    cbs: {
      begin?: (args: { headers: Record<string, string> }) => void;
      done?: () => void;
      error?: (args: { error?: string }) => void;
    };
  }
  return {
    files: new Map<string, Uint8Array>(),
    dirs: new Set<string>(),
    kv: new Map<string, string>(),
    tasks: [] as FakeTask[],
    fetchImpl: async () => new Response(null, { status: 404 }),
    DOC: "file:///docs",
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => h.kv.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      h.kv.set(key, value);
    },
    removeItem: async (key: string) => {
      h.kv.delete(key);
    },
  },
}));

vi.mock("expo-file-system", () => {
  class FakeDirectory {
    readonly uri: string;
    constructor(base: FakeDirectory | string, name?: string) {
      const baseUri = typeof base === "string" ? base : base.uri;
      this.uri = name ? `${baseUri}/${name}` : baseUri;
    }
    get exists() {
      return h.dirs.has(this.uri);
    }
    create() {
      h.dirs.add(this.uri);
    }
  }
  class FakeFile {
    private readonly dirUri: string;
    private readonly name: string;
    constructor(dir: FakeDirectory, name: string) {
      this.dirUri = dir.uri;
      this.name = name;
    }
    get uri() {
      return `${this.dirUri}/${this.name}`;
    }
    get exists() {
      return h.files.has(this.uri);
    }
    get size() {
      return h.files.get(this.uri)?.length ?? 0;
    }
    create(options?: { overwrite?: boolean }) {
      if (h.files.has(this.uri) && !options?.overwrite) {
        throw new Error("File exists");
      }
      h.files.set(this.uri, new Uint8Array());
    }
    write(bytes: Uint8Array) {
      h.files.set(this.uri, bytes);
    }
    delete() {
      h.files.delete(this.uri);
    }
    open() {
      return {
        readBytes: (n: number) =>
          (h.files.get(this.uri) ?? new Uint8Array()).slice(0, n),
        close: () => {},
      };
    }
    move(destination: FakeFile) {
      const data = h.files.get(this.uri);
      if (data) {
        h.files.set(destination.uri, data);
        h.files.delete(this.uri);
      }
    }
  }
  return {
    Directory: FakeDirectory,
    File: FakeFile,
    Paths: { document: h.DOC },
  };
});

vi.mock("@kesha-antonov/react-native-background-downloader", () => ({
  directories: { documents: h.DOC },
  completeHandler: vi.fn(),
  getExistingDownloadTasks: vi.fn(async () => []),
  createDownloadTask: vi.fn((options: { id: string; metadata?: unknown }) => {
    const task = {
      id: options.id,
      metadata: options.metadata as { owners?: string[]; track?: unknown },
      cbs: {} as Record<string, never>,
      begin(cb: (args: { headers: Record<string, string> }) => void) {
        this.cbs.begin = cb;
        return this;
      },
      progress(
        cb: (args: { bytesDownloaded: number; bytesTotal: number }) => void,
      ) {
        this.cbs.progress = cb;
        return this;
      },
      done(cb: () => void) {
        this.cbs.done = cb;
        return this;
      },
      error(cb: (args: { error?: string }) => void) {
        this.cbs.error = cb;
        return this;
      },
      start() {
        h.tasks.push(this);
        return this;
      },
    };
    return task;
  }),
}));

vi.mock("@preeternal/react-native-cookie-manager", () => ({
  default: { get: async () => ({}) },
}));

vi.mock("@music-library/core", () => ({
  downloadStreamUrl: (id: string) => `https://api.test/stream/${id}`,
  getBaseUrl: () => "https://api.test",
  trackCoverUrl: () => "https://api.test/cover",
  isApiOrigin: (u: string) => u.startsWith("https://api.test"),
}));

// live-activity pulls in react-native + expo-widgets (Flow / native-only);
// stub it out — Live Activity behavior is not under test here.
vi.mock("../lib/downloads/live-activity", () => ({
  downloadLiveActivity: {
    begin: vi.fn(),
    noteProgress: vi.fn(),
    noteDone: vi.fn(),
    noteFailed: vi.fn(),
    clearOrphaned: vi.fn(),
  },
}));

// fetch is only used for cover downloads.
vi.stubGlobal("fetch", (...args: unknown[]) => h.fetchImpl(...args));

import type { TrackListItem } from "@music-library/core";
import { createDownloadTask } from "@kesha-antonov/react-native-background-downloader";
import type { downloadStore as storeType } from "../lib/downloads/download-store";

const t = (id: string, albumId = "album1"): TrackListItem => ({
  id,
  title: `Track ${id}`,
  duration_ms: 180_000,
  album_id: albumId,
});

const MP3_HEAD = new Uint8Array([
  0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]); // "ID3..."
const HTML_BODY = new Uint8Array([
  0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]); // "<html>"

async function freshStore(): Promise<typeof storeType> {
  vi.resetModules();
  const mod = await import("../lib/downloads/download-store");
  return mod.downloadStore;
}

function partUri(id: string) {
  return `${h.DOC}/offline-audio/${id}.part`;
}

/**
 * Simulate the native layer finishing a task with the given payload, then
 * await the store's own settle signal: finalize() (cover fetch + persist)
 * always ends in exactly one emit, on success or failure.
 */
async function finishTask(
  store: typeof storeType,
  id: string,
  bytes: Uint8Array,
  contentType = "audio/mpeg",
) {
  const task = h.tasks.find((task) => task.id === id);
  if (!task) throw new Error(`no task for ${id}`);
  h.dirs.add(`${h.DOC}/offline-audio`);
  h.files.set(partUri(id), bytes);
  task.cbs.begin?.({ headers: { "content-type": contentType } });
  const { promise, resolve } = Promise.withResolvers<void>();
  const unsubscribe = store.subscribe(() => {
    unsubscribe();
    resolve();
  });
  task.cbs.done?.();
  await promise;
}

beforeEach(() => {
  h.files.clear();
  h.dirs.clear();
  h.kv.clear();
  h.tasks.length = 0;
  h.fetchImpl = async () => new Response(null, { status: 404 });
  vi.clearAllMocks();
});

describe("downloadStore", () => {
  it("drops hydrated records whose audio file vanished", async () => {
    h.kv.set(
      "offline-downloads.v1",
      JSON.stringify({
        records: [
          {
            trackId: "gone",
            filename: "gone.mp3",
            size: 10,
            downloadedAt: 1,
            owners: ["track"],
          },
        ],
      }),
    );
    const store = await freshStore();
    await store.hydrate();
    expect(store.isDownloaded("gone")).toBe(false);
  });

  it("registers the owner once a download completes", async () => {
    const store = await freshStore();
    await store.downloadTrack(t("a"), "playlist:p1");
    expect(createDownloadTask).toHaveBeenCalledTimes(1);
    expect(store.phaseFor("a")).toBe("downloading");

    await finishTask(store, "a", MP3_HEAD);
    expect(store.isDownloaded("a")).toBe(true);
    expect(store.hasOwner("playlist:p1")).toBe(true);
    expect(store.uriFor("a")).toBe(`${h.DOC}/offline-audio/a.mp3`);
  });

  it("adds a second owner to a stored track without re-downloading", async () => {
    const store = await freshStore();
    await store.downloadTrack(t("a"), "playlist:p1");
    await finishTask(store, "a", MP3_HEAD);

    await store.downloadTrack(t("a"), "track");
    expect(createDownloadTask).toHaveBeenCalledTimes(1);
    expect(store.hasOwner("playlist:p1")).toBe(true);
    expect(store.hasOwner("track")).toBe(true);
  });

  it("keeps the file until the last owner is removed", async () => {
    const store = await freshStore();
    await store.downloadTrack(t("a"), "playlist:p1");
    await finishTask(store, "a", MP3_HEAD);
    await store.downloadTrack(t("a"), "track");

    await store.removeOwner("a", "playlist:p1");
    expect(store.isDownloaded("a")).toBe(true);
    expect(h.files.has(`${h.DOC}/offline-audio/a.mp3`)).toBe(true);

    await store.removeOwner("a", "track");
    expect(store.isDownloaded("a")).toBe(false);
    expect(h.files.has(`${h.DOC}/offline-audio/a.mp3`)).toBe(false);
  });

  it("shares an album cover between tracks and frees it with the last one", async () => {
    h.fetchImpl = async () =>
      new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    const store = await freshStore();
    await store.downloadTrack(t("a"), "track");
    await store.downloadTrack(t("b"), "track");
    await finishTask(store, "a", MP3_HEAD);
    await finishTask(store, "b", MP3_HEAD);

    const coverUri = `${h.DOC}/offline-audio/covers/cover_album1.jpg`;
    expect(h.files.has(coverUri)).toBe(true);
    expect(store.coverUriFor("a")).toBe(coverUri);
    expect(store.coverUriFor("b")).toBe(coverUri);

    await store.removeOwner("a", "track");
    expect(h.files.has(coverUri)).toBe(true);
    await store.removeOwner("b", "track");
    expect(h.files.has(coverUri)).toBe(false);
  });

  it("rejects a download whose bytes are an error page", async () => {
    const store = await freshStore();
    await store.downloadTrack(t("a"), "track");
    await finishTask(store, "a", HTML_BODY, "text/html");

    expect(store.isDownloaded("a")).toBe(false);
    expect(store.phaseFor("a")).toBe("error");
    expect(h.files.has(partUri("a"))).toBe(false);
  });

  it("noteTracks backfills missing offline snapshots", async () => {
    h.kv.set(
      "offline-downloads.v1",
      JSON.stringify({
        records: [
          {
            trackId: "a",
            filename: "a.mp3",
            size: 4,
            downloadedAt: 1,
            owners: ["playlist:p1"],
          },
        ],
      }),
    );
    h.dirs.add(`${h.DOC}/offline-audio`);
    h.files.set(`${h.DOC}/offline-audio/a.mp3`, new Uint8Array([1, 2, 3, 4]));
    const store = await freshStore();
    await store.hydrate();
    expect(store.tracksForOwner("playlist:p1")).toEqual([]);

    store.noteTracks([t("a")]);
    expect(store.tracksForOwner("playlist:p1").map((x) => x.id)).toEqual([
      "a",
    ]);
  });
});
