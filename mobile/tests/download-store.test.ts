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
    destination: string;
    stop: () => Promise<void>;
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
    writes: [] as { key: string; value: string }[],
    beforeWrite: async () => {},
    listPlaylistTracks: vi.fn(),
    baseUrl: "https://api.test",
    cookieRead: async () => ({}),
    fetchImpl: async () => new Response(null, { status: 404 }),
    DOC: "file:///docs",
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => h.kv.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      h.writes.push({ key, value });
      await h.beforeWrite();
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
  createDownloadTask: vi.fn((options: { id: string; destination: string; metadata?: unknown }) => {
    const task = {
      id: options.id,
      destination: options.destination,
      stop: vi.fn(async () => {}),
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
  default: { get: () => h.cookieRead() },
}));

vi.mock("../lib/offline-mode", () => ({ offlineStore: { isOffline: () => false } }));

vi.mock("@music-library/core", () => ({
  api: { listPlaylistTracks: (id: string) => h.listPlaylistTracks(id) },
  playlistEntryToTrack: (entry: { track_id: string; title: string; duration_ms: number }) => ({
    ...entry, id: entry.track_id,
  }),
  downloadStreamUrl: (id: string) => `https://api.test/stream/${id}`,
  getBaseUrl: () => h.baseUrl,
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
import { createDownloadTask, getExistingDownloadTasks } from "@kesha-antonov/react-native-background-downloader";
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
  return mod.setDownloadAccount("alice");
}

function partUri(id: string) {
  return `${h.DOC}/offline-audio-v2/https_3A_2F_2Fapi.test/alice/${id}.part`;
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
  const task = h.tasks.findLast((task) => task.id === `${store.accountKey}:${id}`);
  if (!task) throw new Error(`no task for ${id}`);
  h.dirs.add(`${h.DOC}/offline-audio-v2/https_3A_2F_2Fapi.test/alice`);
  h.files.set(partUri(id), bytes);
  task.cbs.begin?.({ headers: { "content-type": contentType } });
  // Hand-rolled deferred rather than Promise.withResolvers, which needs
  // Node 22 — CI and both Docker images run Node 20.
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  const unsubscribe = store.subscribe(() => {
    if (store.isActive(id)) return;
    unsubscribe();
    resolve();
  });
  task.cbs.done?.();
  await promise;
}

beforeEach(() => {
  h.baseUrl = "https://api.test";
  h.cookieRead = async () => ({});
  h.files.clear();
  h.dirs.clear();
  h.kv.clear();
  h.tasks.length = 0;
  h.writes.length = 0;
  h.beforeWrite = async () => {};
  h.listPlaylistTracks.mockReset().mockResolvedValue({ tracks: [] });
  h.fetchImpl = async () => new Response(null, { status: 404 });
  vi.clearAllMocks();
  vi.mocked(getExistingDownloadTasks).mockResolvedValue([]);
});

describe("downloadStore", () => {
  it("drops hydrated records whose audio file vanished", async () => {
    h.kv.set(
      `offline-downloads.v2:${JSON.stringify(["https://api.test", "alice"])}`,
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
    expect(store.uriFor("a")).toBe(`${h.DOC}/offline-audio-v2/https_3A_2F_2Fapi.test/alice/a.mp3`);
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
    expect(h.files.has(`${h.DOC}/offline-audio-v2/https_3A_2F_2Fapi.test/alice/a.mp3`)).toBe(true);

    await store.removeOwner("a", "track");
    expect(store.isDownloaded("a")).toBe(false);
    expect(h.files.has(`${h.DOC}/offline-audio-v2/https_3A_2F_2Fapi.test/alice/a.mp3`)).toBe(false);
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

    const coverUri = `${h.DOC}/offline-audio-v2/https_3A_2F_2Fapi.test/alice/covers/cover_album1.jpg`;
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
      `offline-downloads.v2:${JSON.stringify(["https://api.test", "alice"])}`,
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
    h.dirs.add(`${h.DOC}/offline-audio-v2/https_3A_2F_2Fapi.test/alice`);
    h.files.set(`${h.DOC}/offline-audio-v2/https_3A_2F_2Fapi.test/alice/a.mp3`, new Uint8Array([1, 2, 3, 4]));
    const store = await freshStore();
    await store.hydrate();
    expect(store.tracksForOwner("playlist:p1")).toEqual([]);

    store.noteTracks([t("a")]);
    expect(store.tracksForOwner("playlist:p1").map((x) => x.id)).toEqual([
      "a",
    ]);
  });
});


describe("account isolation", () => {
  it("isolates files and shared playlist snapshots by both server and account", async () => {
    const alice = await freshStore();
    await alice.downloadTrack(t("private"), "playlist:shared");
    await finishTask(alice, "private", MP3_HEAD);
    const { setDownloadAccount } = await import("../lib/downloads/download-store");
    const bob = setDownloadAccount("bob");
    await bob.hydrate();
    expect(bob.uriFor("private")).toBeUndefined();
    expect(bob.tracksForOwner("playlist:shared")).toEqual([]);
    expect(alice.uriFor("private")).toBeUndefined();
    h.baseUrl = "https://other.test";
    const otherServer = setDownloadAccount("alice");
    await otherServer.hydrate();
    expect(otherServer.uriFor("private")).toBeUndefined();
    h.baseUrl = "https://api.test";
    const restored = setDownloadAccount("alice");
    await restored.hydrate();
    expect(restored.isDownloaded("private")).toBe(true);
  });

  it("retires a cookie lookup before it can enqueue under the new account", async () => {
    const alice = await freshStore();
    await alice.hydrate();
    let resolveCookie!: () => void;
    h.cookieRead = () => new Promise((resolve) => { resolveCookie = () => resolve({}); });
    const pending = alice.downloadTrack(t("private"), "track");
    await vi.waitFor(() => expect(resolveCookie).toBeTypeOf("function"));
    const { setDownloadAccount } = await import("../lib/downloads/download-store");
    setDownloadAccount("bob");
    resolveCookie();
    await pending;
    expect(createDownloadTask).not.toHaveBeenCalled();
  });

  it("stops active transfers and ignores their late completion after logout", async () => {
    const alice = await freshStore();
    await alice.downloadTrack(t("private"), "track");
    const task = h.tasks[0];
    const { setDownloadAccount } = await import("../lib/downloads/download-store");
    const guest = setDownloadAccount(null);
    expect(task.stop).toHaveBeenCalledOnce();
    h.files.set(task.destination, MP3_HEAD);
    task.cbs.done?.();
    await Promise.resolve();
    expect(guest.uriFor("private")).toBeUndefined();
    expect(alice.uriFor("private")).toBeUndefined();
  });

  it("does not adopt legacy downloads without a known account owner", async () => {
    h.kv.set("offline-downloads.v1", JSON.stringify({ records: [{ trackId: "private", filename: "private.mp3", owners: ["playlist:shared"], track: t("private") }] }));
    h.files.set(`${h.DOC}/offline-audio/private.mp3`, MP3_HEAD);
    const alice = await freshStore();
    await alice.hydrate();
    expect(alice.tracksForOwner("playlist:shared")).toEqual([]);
  });
});

function seedDownloads(ids: string[], owner = "playlist:p1", cover = false) {
  const dir = `${h.DOC}/offline-audio-v2/https_3A_2F_2Fapi.test/alice`;
  const records = ids.map((id) => {
    h.files.set(`${dir}/${id}.mp3`, MP3_HEAD);
    return {
      trackId: id, filename: `${id}.mp3`, size: MP3_HEAD.length,
      downloadedAt: 1, owners: [owner], track: t(id),
      coverFilename: cover ? "cover_album1.jpg" : undefined,
    };
  });
  if (cover) h.files.set(`${dir}/covers/cover_album1.jpg`, new Uint8Array([1, 2, 3, 4]));
  h.kv.set(`offline-downloads.v2:${JSON.stringify([h.baseUrl, "alice"])}`, JSON.stringify({ records }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function coverResponse() {
  return new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
    headers: { "content-type": "image/jpeg" },
  });
}

describe("batched download mutations", () => {
  it("removes a large playlist with one write and notification while preserving shared files", async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `track${i}`);
    seedDownloads(ids, "playlist:p1", true);
    const store = await freshStore();
    await store.hydrate();
    await store.downloadTrack(t(ids[0]), "playlist:p2");
    const coverUri = store.coverUriFor(ids[0])!;
    h.writes.length = 0;
    const listener = vi.fn();
    store.subscribe(listener);
    await store.removePlaylist("p1", ids);
    expect(h.writes).toHaveLength(1);
    expect(listener).toHaveBeenCalledOnce();
    expect(store.tracksForOwner("playlist:p1")).toEqual([]);
    expect(store.tracksForOwner("playlist:p2").map((track) => track.id)).toEqual([ids[0]]);
    expect(h.files.has(coverUri)).toBe(true);
    await store.removePlaylist("p2", [ids[0]]);
    expect(h.files.has(coverUri)).toBe(false);
  });

  it("attaches a playlist to stored tracks with one write and no transfers", async () => {
    const ids = ["a", "b", "c"];
    seedDownloads(ids);
    const store = await freshStore();
    await store.hydrate();
    h.writes.length = 0;
    const listener = vi.fn();
    store.subscribe(listener);
    await store.downloadPlaylist("p2", ids.map((id) => t(id)));
    expect(h.writes).toHaveLength(1);
    expect(listener).toHaveBeenCalledOnce();
    expect(createDownloadTask).not.toHaveBeenCalled();
    expect(store.tracksForOwner("playlist:p2")).toHaveLength(3);
    await store.downloadPlaylist("p2", ids.map((id) => t(id)));
    expect(h.writes).toHaveLength(1);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("serializes overlapping writes and persists the latest ownership", async () => {
    seedDownloads(["a"]);
    const store = await freshStore();
    await store.hydrate();
    const gate = deferred<void>();
    h.beforeWrite = () => gate.promise;
    const first = store.downloadTrack(t("a"), "playlist:p2");
    await vi.waitFor(() => expect(h.writes).toHaveLength(1));
    const second = store.downloadTrack(t("a"), "playlist:p3");
    await Promise.resolve();
    await Promise.resolve();
    expect(h.writes).toHaveLength(1);
    gate.resolve();
    await Promise.all([first, second]);
    const saved = JSON.parse(h.kv.get(`offline-downloads.v2:${store.accountKey}`)!);
    expect(saved.records[0].owners).toEqual(["playlist:p1", "playlist:p2", "playlist:p3"]);
  });
});

describe("artwork reuse", () => {
  it("reuses hydrated artwork without a request", async () => {
    seedDownloads(["a"], "track", true);
    const store = await freshStore();
    h.fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    await store.downloadTrack(t("b"), "track");
    await finishTask(store, "b", MP3_HEAD);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(store.coverUriFor("b")).toBe(store.coverUriFor("a"));
  });

  it("shares an in-flight request and releases artwork only after both tracks are removed", async () => {
    const gate = deferred<Response>();
    h.fetchImpl = vi.fn(() => gate.promise);
    const store = await freshStore();
    await store.downloadPlaylist("p1", [t("a"), t("b")]);
    const completed = Promise.all([finishTask(store, "a", MP3_HEAD), finishTask(store, "b", MP3_HEAD)]);
    await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalledOnce());
    gate.resolve(coverResponse());
    await completed;
    const uri = store.coverUriFor("a")!;
    expect(uri).toBe(store.coverUriFor("b"));
    expect(h.files.has(uri)).toBe(true);
    await store.removeOwner("a", "playlist:p1");
    expect(h.files.has(uri)).toBe(true);
    await store.removeOwner("b", "playlist:p1");
    expect(h.files.has(uri)).toBe(false);
  });

  it("retries failed artwork on a later track", async () => {
    h.fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })).mockImplementation(coverResponse);
    const store = await freshStore();
    await store.downloadTrack(t("a"), "track");
    await finishTask(store, "a", MP3_HEAD);
    await store.downloadTrack(t("b"), "track");
    await finishTask(store, "b", MP3_HEAD);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(store.coverUriFor("b")).toBeDefined();
  });

  it("does not resurrect removed owners when concurrent downloads complete", async () => {
    const gate = deferred<Response>();
    h.fetchImpl = vi.fn(() => gate.promise);
    const store = await freshStore();
    await store.downloadTrack(t("a"), "playlist:p1");
    await store.downloadTrack(t("b"), "playlist:p2");
    const completed = Promise.all([finishTask(store, "a", MP3_HEAD), finishTask(store, "b", MP3_HEAD)]);
    await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalledOnce());
    await store.downloadPlaylist("p1", [], { reconcile: true });
    gate.resolve(coverResponse());
    await completed;
    expect(store.isDownloaded("a")).toBe(false);
    expect(store.hasOwner("playlist:p1")).toBe(false);
    expect(store.isDownloaded("b")).toBe(true);
    expect(h.files.has(store.coverUriFor("b")!)).toBe(true);
    await store.removeOwner("b", "playlist:p2");
    expect([...h.files.keys()].filter((path) => path.includes("/covers/"))).toEqual([]);
  });
});

async function autoStore(store: typeof storeType, playlistId = "p2") {
  h.kv.set(`auto-download.playlists.v1:v2:${store.accountKey}`, JSON.stringify([playlistId]));
  const { setAutoDownloadAccount } = await import("../lib/downloads/auto-download");
  return setAutoDownloadAccount(store);
}

function serverTracks(ids: string[]) {
  return { tracks: ids.map((id) => ({ ...t(id), track_id: id })) };
}

describe("automatic ownership reconciliation", () => {
  it("forgets deleted playlists without removing tracks retained elsewhere", async () => {
    seedDownloads(["a", "b"], "playlist:p2");
    const store = await freshStore();
    const auto = await autoStore(store);
    await store.downloadTrack(t("b"), "track");
    await store.downloadTrack(t("pending"), "playlist:p2");
    const gate = deferred<ReturnType<typeof serverTracks>>();
    h.listPlaylistTracks.mockReturnValue(gate.promise);
    const sync = auto.sync("p2");
    await vi.waitFor(() => expect(h.listPlaylistTracks).toHaveBeenCalledOnce());

    await auto.removePlaylist("p2");
    gate.resolve(serverTracks(["a", "new"]));
    await sync;
    await finishTask(store, "pending", MP3_HEAD);
    expect(auto.isEnabled("p2")).toBe(false);
    expect(store.hasOwner("playlist:p2")).toBe(false);
    expect(store.isDownloaded("a")).toBe(false);
    expect(store.isDownloaded("b")).toBe(true);
    expect(store.isDownloaded("pending")).toBe(false);
    expect(createDownloadTask).toHaveBeenCalledTimes(1);

    h.listPlaylistTracks.mockClear();
    await auto.syncAll();
    expect(h.listPlaylistTracks).not.toHaveBeenCalled();
    const { setAutoDownloadAccount } = await import("../lib/downloads/auto-download");
    const restored = setAutoDownloadAccount(store);
    await restored.hydrate();
    expect(restored.isEnabled("p2")).toBe(false);
  });

  it("removes manual playlist downloads even when auto-download was never enabled", async () => {
    seedDownloads(["a"], "playlist:manual");
    const store = await freshStore();
    const auto = await autoStore(store);
    await auto.removePlaylist("manual");
    expect(store.isDownloaded("a")).toBe(false);
    expect(store.hasOwner("playlist:manual")).toBe(false);
    expect(auto.isEnabled("p2")).toBe(true);
  });

  it("retains an existing download for a second playlist", async () => {
    seedDownloads(["a"]);
    const store = await freshStore();
    const auto = await autoStore(store);
    h.listPlaylistTracks.mockResolvedValue(serverTracks(["a"]));
    await auto.sync("p2");
    await store.removePlaylist("p1", ["a"]);
    expect(store.isDownloaded("a")).toBe(true);
    expect(store.hasOwner("playlist:p2")).toBe(true);
    expect(createDownloadTask).not.toHaveBeenCalled();
  });

  it("removes obsolete owners after successful responses, including empty playlists", async () => {
    seedDownloads(["a", "b"], "playlist:p2");
    const store = await freshStore();
    const auto = await autoStore(store);
    h.listPlaylistTracks.mockResolvedValue(serverTracks(["b"]));
    await auto.sync("p2");
    expect(store.isDownloaded("a")).toBe(false);
    expect(store.isDownloaded("b")).toBe(true);
    h.listPlaylistTracks.mockResolvedValue(serverTracks([]));
    await auto.sync("p2");
    expect(store.isDownloaded("b")).toBe(false);
  });

  it("keeps downloads on failed or malformed responses and adds ownership from screen data", async () => {
    seedDownloads(["a", "b"], "playlist:p2");
    const store = await freshStore();
    const auto = await autoStore(store);
    h.listPlaylistTracks.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({});
    await auto.sync("p2");
    await auto.sync("p2");
    await auto.syncWithTracks("p2", [t("a")]);
    expect(store.isDownloaded("a")).toBe(true);
    expect(store.isDownloaded("b")).toBe(true);
    await store.downloadTrack(t("a"), "playlist:p1");
    await store.removeOwner("a", "playlist:p2");
    await auto.syncWithTracks("p2", [t("a")]);
    await store.removeOwner("a", "playlist:p1");
    expect(store.isDownloaded("a")).toBe(true);
  });

  it("ignores an in-flight response after automatic downloads are disabled", async () => {
    seedDownloads(["a"], "playlist:p2");
    const store = await freshStore();
    const auto = await autoStore(store);
    const gate = deferred<ReturnType<typeof serverTracks>>();
    h.listPlaylistTracks.mockReturnValue(gate.promise);
    const sync = auto.sync("p2");
    await vi.waitFor(() => expect(h.listPlaylistTracks).toHaveBeenCalledOnce());
    await auto.setEnabled("p2", false);
    gate.resolve(serverTracks([]));
    await sync;
    await store.hydrate();
    expect(store.isDownloaded("a")).toBe(true);
  });
});


describe("pending ownership after restart", () => {
  it.each([false, true])("restores pending owner removals (remaining owner: %s)", async (keepSecondOwner) => {
    const store = await freshStore();
    await store.downloadTrack(t("a"), "playlist:p1");
    if (keepSecondOwner) await store.downloadTrack(t("a"), "playlist:p2");
    await store.removeOwner("a", "playlist:p1");
    const task = h.tasks[0];
    vi.mocked(getExistingDownloadTasks).mockResolvedValue([
      task as unknown as Awaited<ReturnType<typeof getExistingDownloadTasks>>[number],
    ]);
    const restored = await freshStore();
    await restored.hydrate();
    await finishTask(restored, "a", MP3_HEAD);
    expect(restored.hasOwner("playlist:p1")).toBe(false);
    expect(restored.hasOwner("playlist:p2")).toBe(keepSecondOwner);
    expect(restored.isDownloaded("a")).toBe(keepSecondOwner);
  });
});
