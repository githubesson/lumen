import { Directory, File, Paths } from "expo-file-system";
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
 * Writes are best-effort and fully guarded: a failed or half-written cache just
 * yields a restore miss (queries refetch when back online), never a crash — the
 * whole point is to keep the app from "crapping itself" offline.
 */

const CACHE_DIR = "query-cache";
const CACHE_FILE = "react-query.json";

function cacheFile(): File {
  return new File(new Directory(Paths.document, CACHE_DIR), CACHE_FILE);
}

export const fileSystemPersister: Persister = {
  persistClient(client: PersistedClient) {
    try {
      const dir = new Directory(Paths.document, CACHE_DIR);
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
      const file = cacheFile();
      file.create({ intermediates: true, overwrite: true });
      file.write(JSON.stringify(client));
    } catch {
      // Best effort: the in-memory cache is unaffected by a failed persist.
    }
  },
  restoreClient() {
    try {
      const file = cacheFile();
      if (!file.exists) return undefined;
      return JSON.parse(file.textSync()) as PersistedClient;
    } catch {
      return undefined;
    }
  },
  removeClient() {
    try {
      const file = cacheFile();
      if (file.exists) file.delete();
    } catch {
      // Ignore: a leftover file is overwritten on the next persist.
    }
  },
};
