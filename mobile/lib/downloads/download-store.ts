import AsyncStorage from "@react-native-async-storage/async-storage";
import { Directory, File, Paths } from "expo-file-system";
import {
  downloadStreamUrl,
  trackCoverUrl,
  type TrackListItem,
} from "@music-library/core";
import { extensionForContentType, fetchStreamBytes } from "../track-download";

/**
 * Device-local offline audio store, Spotify-style: files live in the app's
 * private document directory (never exposed to a file browser) and are keyed by
 * track id so playback can swap in a `file://` URI transparently.
 *
 * A single module-level instance backs both the reactive UI (via
 * `useSyncExternalStore`) and the player's synchronous URI resolver, so the
 * in-memory record map is the source of truth and AsyncStorage is just its
 * durable mirror.
 */

const STORAGE_KEY = "offline-downloads.v1";
const DIR_NAME = "offline-audio";
const DEFAULT_EXTENSION = "mp3";
/** Concurrent per-track downloads when materializing a whole playlist. */
const PLAYLIST_CONCURRENCY = 3;
/** Subdirectory (inside the offline dir) holding downloaded cover artwork. */
const COVER_DIR = "covers";
/** Pixel size fetched for offline covers — large enough for the now-playing
 *  hero, downscaled by expo-image for rows. */
const COVER_SIZE = 640;

/** An owner that keeps a downloaded track alive; a track is deleted only when
 *  its last owner is removed. Playlists own their tracks as `playlist:<id>`. */
export type DownloadOwner = string;

export function playlistOwner(playlistId: string): DownloadOwner {
  return `playlist:${playlistId}`;
}

export interface DownloadRecord {
  trackId: string;
  /** Basename inside the offline directory; the absolute URI is rebuilt on
   *  read since iOS can change the container path across app updates. */
  filename: string;
  size: number;
  downloadedAt: number;
  /** Reasons this file is retained (playlist ids, etc.). */
  owners: DownloadOwner[];
  /** Basename of the stored cover image inside {@link COVER_DIR}, if any.
   *  Shared across tracks of the same album (keyed by album id). */
  coverFilename?: string;
}

export type DownloadPhase =
  | "idle"
  | "downloading"
  | "downloaded"
  | "error";

type Listener = () => void;

interface PersistShape {
  records?: DownloadRecord[];
}

class DownloadStore {
  private records = new Map<string, DownloadRecord>();
  /** Track ids with an in-flight download. */
  private active = new Set<string>();
  /** Owners requested for a track while its download is in flight. */
  private pendingOwners = new Map<string, Set<DownloadOwner>>();
  private errors = new Map<string, string>();
  private listeners = new Set<Listener>();
  private hydrated = false;
  private hydrating: Promise<void> | null = null;
  /** Bumped on every mutation; used as the external-store snapshot. */
  private version = 0;

  // ── subscription (useSyncExternalStore) ───────────────────────────────────
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = (): number => this.version;

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  get ready(): boolean {
    return this.hydrated;
  }

  // ── paths ─────────────────────────────────────────────────────────────────
  private get dir(): Directory {
    return new Directory(Paths.document, DIR_NAME);
  }

  private fileFor(filename: string): File {
    return new File(this.dir, filename);
  }

  private ensureDir(): Directory {
    const dir = this.dir;
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    return dir;
  }

  private get coverDir(): Directory {
    return new Directory(this.dir, COVER_DIR);
  }

  private coverFileFor(filename: string): File {
    return new File(this.coverDir, filename);
  }

  private ensureCoverDir(): Directory {
    this.ensureDir();
    const dir = this.coverDir;
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    return dir;
  }

  // ── synchronous reads (safe for the player resolver) ──────────────────────
  /** Absolute `file://` URI for offline playback, or undefined if not stored. */
  uriFor = (trackId: string): string | undefined => {
    const record = this.records.get(trackId);
    if (!record) return undefined;
    return this.fileFor(record.filename).uri;
  };

  /** Absolute `file://` URI for a stored offline cover, or undefined. */
  coverUriFor = (trackId: string | undefined): string | undefined => {
    if (!trackId) return undefined;
    const record = this.records.get(trackId);
    if (!record?.coverFilename) return undefined;
    return this.coverFileFor(record.coverFilename).uri;
  };

  isDownloaded(trackId: string): boolean {
    return this.records.has(trackId);
  }

  isActive(trackId: string): boolean {
    return this.active.has(trackId);
  }

  phaseFor(trackId: string): DownloadPhase {
    if (this.records.has(trackId)) return "downloaded";
    if (this.active.has(trackId)) return "downloading";
    if (this.errors.has(trackId)) return "error";
    return "idle";
  }

  errorFor(trackId: string): string | undefined {
    return this.errors.get(trackId);
  }

  // ── hydration ─────────────────────────────────────────────────────────────
  hydrate(): Promise<void> {
    if (this.hydrated) return Promise.resolve();
    if (this.hydrating) return this.hydrating;
    this.hydrating = this.doHydrate();
    return this.hydrating;
  }

  private async doHydrate(): Promise<void> {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as PersistShape) : null;
      const dir = this.dir;
      let mutated = false;
      for (const record of parsed?.records ?? []) {
        if (!record?.trackId || !record?.filename) {
          mutated = true;
          continue;
        }
        // A record is only valid if its file still exists — the OS can offload
        // the document dir and app updates can invalidate stale entries.
        const file = new File(dir, record.filename);
        if (!file.exists) {
          mutated = true;
          continue;
        }
        let coverFilename = record.coverFilename;
        if (
          coverFilename &&
          !new File(new Directory(dir, COVER_DIR), coverFilename).exists
        ) {
          coverFilename = undefined;
          mutated = true;
        }
        this.records.set(record.trackId, {
          trackId: record.trackId,
          filename: record.filename,
          size: record.size || file.size || 0,
          downloadedAt: record.downloadedAt || Date.now(),
          owners:
            Array.isArray(record.owners) && record.owners.length
              ? record.owners
              : ["track"],
          coverFilename,
        });
      }
      if (mutated) await this.persist();
    } catch {
      // Best effort — a corrupt store just starts empty.
    } finally {
      this.hydrated = true;
      this.hydrating = null;
      this.emit();
    }
  }

  private async persist(): Promise<void> {
    try {
      const records = [...this.records.values()];
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ records } satisfies PersistShape),
      );
    } catch {
      // Non-fatal: the in-memory map still drives this session.
    }
  }

  // ── mutations ───────────────────────────────────────────────────────────
  /**
   * Download a single track (idempotent) and attach `owner`. If the track is
   * already stored, the owner is simply registered. If a download is already in
   * flight, the owner is queued so it lands when the download settles.
   */
  async downloadTrack(track: TrackListItem, owner: DownloadOwner): Promise<void> {
    await this.hydrate();

    const existing = this.records.get(track.id);
    if (existing) {
      this.addOwner(existing, owner);
      return;
    }

    if (this.active.has(track.id)) {
      this.queueOwner(track.id, owner);
      return;
    }

    this.active.add(track.id);
    this.errors.delete(track.id);
    this.queueOwner(track.id, owner);
    this.emit();

    try {
      const dir = this.ensureDir();
      const { bytes, contentType } = await fetchStreamBytes(
        downloadStreamUrl(track.id),
      );
      const ext = extensionForContentType(contentType) ?? DEFAULT_EXTENSION;
      const filename = `${sanitizeId(track.id)}.${ext}`;
      const file = new File(dir, filename);
      file.create({ intermediates: true, overwrite: true });
      file.write(bytes);
      // Cover art is best-effort: a missing/failed cover must not fail the
      // audio download, so this never throws.
      const coverFilename = await this.downloadCover(track);

      const owners = [...(this.pendingOwners.get(track.id) ?? new Set([owner]))];
      this.records.set(track.id, {
        trackId: track.id,
        filename,
        size: file.size || bytes.length,
        downloadedAt: Date.now(),
        owners,
        coverFilename,
      });
      await this.persist();
    } catch (error) {
      this.errors.set(
        track.id,
        error instanceof Error ? error.message : "Download failed",
      );
      throw error;
    } finally {
      this.active.delete(track.id);
      this.pendingOwners.delete(track.id);
      this.emit();
    }
  }

  /** Remove an owner; deletes the file only when no owners remain. */
  async removeOwner(trackId: string, owner: DownloadOwner): Promise<void> {
    const record = this.records.get(trackId);
    if (!record) return;
    const owners = record.owners.filter((existing) => existing !== owner);
    if (owners.length > 0) {
      record.owners = owners;
      await this.persist();
      this.emit();
      return;
    }
    await this.deleteRecord(trackId, record);
  }

  private async deleteRecord(
    trackId: string,
    record: DownloadRecord,
  ): Promise<void> {
    try {
      const file = this.fileFor(record.filename);
      if (file.exists) file.delete();
    } catch {
      // The record is dropped regardless; a leaked file is reclaimed on the
      // next hydrate (missing owners) or by the OS clearing the container.
    }
    this.records.delete(trackId);
    this.errors.delete(trackId);
    // Covers are shared per album; delete the file only when no remaining
    // record still points at it.
    if (record.coverFilename) {
      const stillUsed = [...this.records.values()].some(
        (other) => other.coverFilename === record.coverFilename,
      );
      if (!stillUsed) {
        try {
          const cover = this.coverFileFor(record.coverFilename);
          if (cover.exists) cover.delete();
        } catch {
          // Leaked cover is reclaimed on the next hydrate sweep.
        }
      }
    }
    await this.persist();
    this.emit();
  }

  // ── playlist-level ─────────────────────────────────────────────────────────
  /**
   * Download every track for a playlist under a `playlist:<id>` owner, with a
   * small concurrency cap. Per-track failures are swallowed so one bad track
   * never aborts the batch; the UI reflects the downloaded/total count.
   */
  async downloadPlaylist(
    playlistId: string,
    tracks: TrackListItem[],
  ): Promise<void> {
    await this.hydrate();
    const owner = playlistOwner(playlistId);
    const queue = tracks.slice();

    const worker = async (): Promise<void> => {
      for (;;) {
        const track = queue.shift();
        if (!track) return;
        try {
          await this.downloadTrack(track, owner);
        } catch {
          // Already recorded as a per-track error; keep going.
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(PLAYLIST_CONCURRENCY, queue.length) },
      () => worker(),
    );
    await Promise.all(workers);
  }

  /** Drop a playlist's ownership from every track it downloaded. */
  async removePlaylist(
    playlistId: string,
    trackIds: string[],
  ): Promise<void> {
    await this.hydrate();
    const owner = playlistOwner(playlistId);
    for (const trackId of trackIds) {
      await this.removeOwner(trackId, owner);
    }
  }

  private addOwner(record: DownloadRecord, owner: DownloadOwner): void {
    if (record.owners.includes(owner)) return;
    record.owners = [...record.owners, owner];
    void this.persist();
    this.emit();
  }

  private queueOwner(trackId: string, owner: DownloadOwner): void {
    const owners = this.pendingOwners.get(trackId) ?? new Set<DownloadOwner>();
    owners.add(owner);
    this.pendingOwners.set(trackId, owners);
  }

  /**
   * Best-effort cover download. Returns the stored cover basename, or undefined
   * when the track has no artwork or the fetch fails — never throws, so audio
   * downloads succeed regardless. Covers are keyed by album so tracks of the
   * same album reuse a single file.
   */
  private async downloadCover(
    track: TrackListItem,
  ): Promise<string | undefined> {
    if (track.has_cover === false) return undefined;
    try {
      const response = await fetch(trackCoverUrl(track, COVER_SIZE), {
        credentials: "include",
      });
      if (!response.ok) return undefined;
      const contentType = response.headers.get("content-type") ?? undefined;
      if (!contentType?.toLowerCase().startsWith("image/")) return undefined;
      const coverKey = track.album_id || track.id;
      const filename = `cover_${sanitizeId(coverKey)}.${extensionForImageContentType(contentType)}`;
      const file = new File(this.ensureCoverDir(), filename);
      if (!file.exists) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length < 4) return undefined;
        file.create({ intermediates: true, overwrite: true });
        file.write(bytes);
      }
      return filename;
    } catch {
      return undefined;
    }
  }
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function extensionForImageContentType(contentType: string): string {
  switch (contentType.split(";")[0]?.toLowerCase().trim()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/heic":
    case "image/heif":
      return "heic";
    case "image/avif":
      return "avif";
    default:
      return "jpg";
  }
}

export const downloadStore = new DownloadStore();
