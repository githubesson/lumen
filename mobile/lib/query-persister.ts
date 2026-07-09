import { Directory, File, Paths } from "expo-file-system";
import * as FileSystem from "expo-file-system/legacy";
import {
  defaultShouldDehydrateQuery,
  type Query,
} from "@tanstack/react-query";
import type {
  PersistedClient,
  Persister,
} from "@tanstack/react-query-persist-client";

/**
 * Disk-backed React Query persister so browse/detail pages survive a cold
 * launch with no network. The dehydrated cache is written to a single JSON file
 * in the app's private document directory (not AsyncStorage — which caps out
 * around a few MB on Android, and the metadata cache can grow past that).
 *
 * Only offline-useful successful queries reach this persister. Writes are
 * coalesced, bounded and staged through a temporary file so a failed write
 * yields a restore miss rather than a partially-written cache.
 */

const CACHE_DIR = "query-cache";
const CACHE_FILE = "react-query.json";
const TEMP_CACHE_FILE = `${CACHE_FILE}.tmp`;
const WRITE_DEBOUNCE_MS = 1000;
const MAX_PERSISTED_QUERIES = 120;
const MAX_PERSISTED_INFINITE_PAGES = 5;

const PERSISTED_USER_QUERY_TYPES = new Set([
  "playlists",
  "playlist",
  "playlist-tracks",
  "favorites",
  "recent",
  "album",
  "album-tracks",
  "tidal-album",
  "artist",
  "artist-tracks",
  "track",
]);

let pendingClient: PersistedClient | undefined;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
let writeChain: Promise<void> = Promise.resolve();

function cacheDirectory(): Directory {
  return new Directory(Paths.document, CACHE_DIR);
}

function cacheFile(): File {
  return new File(cacheDirectory(), CACHE_FILE);
}

function tempCacheFile(): File {
  return new File(cacheDirectory(), TEMP_CACHE_FILE);
}

/** Exclude transient, searched, administrative and non-successful queries. */
export function shouldPersistQuery(query: Query): boolean {
  if (!defaultShouldDehydrateQuery(query)) return false;

  const [root, scope, kind] = query.queryKey;
  if (root === "user") {
    return (
      typeof scope === "string" &&
      typeof kind === "string" &&
      PERSISTED_USER_QUERY_TYPES.has(kind)
    );
  }

  // The unsearched browse lists are useful offline. Search terms are transient
  // and otherwise grow the persisted cache with every distinct query.
  if (root === "tracks" || root === "albums" || root === "artists") {
    return scope === "";
  }

  if (root === "replay") return true;
  return root === "home" && scope === "rediscover";
}

function limitInfiniteData(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const candidate = data as { pages?: unknown; pageParams?: unknown };
  if (!Array.isArray(candidate.pages) || !Array.isArray(candidate.pageParams)) {
    return data;
  }
  if (candidate.pages.length <= MAX_PERSISTED_INFINITE_PAGES) return data;
  return {
    ...candidate,
    pages: candidate.pages.slice(0, MAX_PERSISTED_INFINITE_PAGES),
    pageParams: candidate.pageParams.slice(0, MAX_PERSISTED_INFINITE_PAGES),
  };
}

function boundedClient(client: PersistedClient): PersistedClient {
  const queries = [...client.clientState.queries]
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
    .slice(0, MAX_PERSISTED_QUERIES)
    .map((query) => ({
      ...query,
      state: {
        ...query.state,
        data: limitInfiniteData(query.state.data),
      },
    }));

  return {
    ...client,
    clientState: {
      ...client.clientState,
      mutations: [],
      queries,
    },
  };
}

async function fileExists(file: File): Promise<boolean> {
  return (await FileSystem.getInfoAsync(file.uri)).exists;
}

async function writeSnapshot(client: PersistedClient): Promise<void> {
  const dir = cacheDirectory();
  const file = cacheFile();
  const temp = tempCacheFile();
  if (!(await FileSystem.getInfoAsync(dir.uri)).exists) {
    await FileSystem.makeDirectoryAsync(dir.uri, { intermediates: true });
  }
  await FileSystem.writeAsStringAsync(
    temp.uri,
    JSON.stringify(boundedClient(client)),
  );
  await FileSystem.deleteAsync(file.uri, { idempotent: true });
  await FileSystem.moveAsync({ from: temp.uri, to: file.uri });
}

async function readClient(file: File): Promise<PersistedClient | undefined> {
  if (!(await fileExists(file))) return undefined;
  try {
    return JSON.parse(
      await FileSystem.readAsStringAsync(file.uri),
    ) as PersistedClient;
  } catch {
    return undefined;
  }
}

function flushPendingClient(): void {
  writeTimer = undefined;
  const client = pendingClient;
  pendingClient = undefined;
  if (!client) return;

  writeChain = writeChain
    .catch(() => undefined)
    .then(() => writeSnapshot(client))
    .catch(() => undefined);
}

export const fileSystemPersister: Persister = {
  persistClient(client: PersistedClient) {
    pendingClient = client;
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(flushPendingClient, WRITE_DEBOUNCE_MS);
  },
  async restoreClient() {
    // If the app stopped between staging and renaming, the complete temporary
    // snapshot is still a valid fallback.
    return (await readClient(cacheFile())) ?? readClient(tempCacheFile());
  },
  async removeClient() {
    pendingClient = undefined;
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = undefined;
    }
    await writeChain.catch(() => undefined);
    await Promise.all([
      FileSystem.deleteAsync(cacheFile().uri, { idempotent: true }),
      FileSystem.deleteAsync(tempCacheFile().uri, { idempotent: true }),
    ]).catch(() => undefined);
  },
};
