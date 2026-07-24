import AsyncStorage from "@react-native-async-storage/async-storage";
import { Directory, File, Paths } from "expo-file-system";
import {
  completeHandler,
  createDownloadTask,
  directories,
  getExistingDownloadTasks,
} from "@kesha-antonov/react-native-background-downloader";
import CookieManager from "@preeternal/react-native-cookie-manager";
import {
  downloadStreamUrl,
  getBaseUrl,
  trackCoverUrl,
  isApiOrigin,
  type TrackListItem,
} from "@music-library/core";
import {
  extensionForContentType,
  extensionForMediaBytes,
  isRejectedStreamContentType,
  looksLikeMediaBytes,
} from "../track-download";
import { downloadLiveActivity } from "./live-activity";

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
  /** Snapshot of the track's list metadata, taken when the download was
   *  registered. Lets offline surfaces (e.g. a playlist screen with no
   *  persisted query cache) render and play stored tracks without the
   *  network. Records from before this field may lack it until a download
   *  action touches them again. */
  track?: TrackListItem;
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

  /** Whether any downloaded track is owned by `owner` (e.g. a playlist). */
  hasOwner(owner: DownloadOwner): boolean {
    for (const record of this.records.values()) {
      if (record.owners.includes(owner)) return true;
    }
    return false;
  }

  /** Snapshots of `owner`'s downloaded tracks, in stored order. Only records
   *  carrying a snapshot appear; returns a fresh array (memoize by version). */
  tracksForOwner(owner: DownloadOwner): TrackListItem[] {
    const tracks: TrackListItem[] = [];
    for (const record of this.records.values()) {
      if (record.track && record.owners.includes(owner)) {
        tracks.push(record.track);
      }
    }
    return tracks;
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
    // A process kill orphans any Live Activity from the previous run; end it
    // before re-attaching tasks (which finish without one — the session
    // context needed to resume the card doesn't survive the kill).
    downloadLiveActivity.clearOrphaned();
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
          track:
            record.track?.id === record.trackId ? record.track : undefined,
        });
      }

      // Re-attach to native transfers that survived a process death so their
      // completion still lands in the store. Isolated: a re-attach failure
      // must not break hydration.
      try {
        const tasks = await getExistingDownloadTasks();
        for (const task of tasks) {
          if (this.records.has(task.id)) continue;
          this.active.add(task.id);
          const meta = (task.metadata ?? {}) as TaskMeta;
          task
            .done(() => {
              // No content type on restored tasks — finalize's magic-byte
              // sniffing decides the extension.
              void this.finalize(task.id, undefined, meta).finally(() =>
                completeHandler(task.id),
              );
            })
            .error(({ error }) => {
              this.fail(task.id, error || "Download failed");
              void completeHandler(task.id);
            });
        }
      } catch {
        // Best effort — an unfinished task is simply re-downloaded later.
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
   * Enqueue a background download for a single track (idempotent) and attach
   * `owner`. Resolves when the native task is ENQUEUED, not completed —
   * completion is observed via store subscription (`phaseFor`). If the track
   * is already stored, the owner is simply registered; if a download is in
   * flight, the owner is queued so it lands when the download settles.
   */
  async downloadTrack(track: TrackListItem, owner: DownloadOwner): Promise<void> {
    await this.hydrate();

    const existing = this.records.get(track.id);
    if (existing) {
      // Backfill the offline snapshot on records that predate it.
      if (!existing.track) {
        existing.track = track;
        void this.persist();
      }
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
      await this.startTask(track);
    } catch (error) {
      this.fail(
        track.id,
        error instanceof Error ? error.message : "Download failed",
      );
      throw error;
    }
  }

  /**
   * Hand a track download to the OS as a native background task (survives
   * app suspension and screen lock). Resolves on ENQUEUE; completion runs
   * through `finalize`, failure through `fail`, whenever JS resumes.
   */
  private async startTask(track: TrackListItem): Promise<void> {
    this.ensureDir();
    const partName = `${sanitizeId(track.id)}.part`;
    try {
      const stale = new File(this.dir, partName);
      if (stale.exists) stale.delete();
    } catch {
      // A stale temp file only risks a failed rename; finalize re-checks.
    }

    const headers = await sessionCookieHeader();
    const meta: TaskMeta = {
      // queueOwner ran before startTask, so pendingOwners holds the owner.
      owners: [...(this.pendingOwners.get(track.id) ?? [])],
      // Full snapshot: finalize stores it on the record so offline surfaces
      // can render the track, and reads cover fields from it.
      track,
    };
    let contentType: string | undefined;
    const task = createDownloadTask({
      // The track id makes the task re-attachable after a restart.
      id: track.id,
      url: downloadStreamUrl(track.id),
      // The library expects a plain path (not a file:// URI); its documents
      // dir is the same container as expo-file-system's Paths.document.
      destination: `${directories.documents}/${DIR_NAME}/${partName}`,
      headers,
      metadata: meta,
    })
      .begin(({ headers: responseHeaders }) => {
        contentType = headerValue(responseHeaders, "content-type");
      })
      // Byte-level Live Activity progress. Foreground-only in practice: iOS
      // doesn't deliver progress events to a suspended app (the count beats
      // in finalize/fail cover background updates).
      .progress(({ bytesDownloaded, bytesTotal }) => {
        downloadLiveActivity.noteProgress(track.id, bytesDownloaded, bytesTotal);
      })
      // completeHandler MUST follow both done and error — iOS throttles
      // future background time for apps that never report completion.
      .done(() => {
        void this.finalize(track.id, contentType, meta).finally(() =>
          completeHandler(track.id),
        );
      })
      .error(({ error }) => {
        this.fail(track.id, error || "Download failed");
        void completeHandler(track.id);
      });
    task.start();
  }

  /**
   * Validate and persist a finished native download. NSURLSession does NOT
   * error on HTTP 401/500 — the error body lands in the file — so sniffing
   * the payload here is the only guard against storing an error page as
   * audio (parity with the old `fetchStreamBytes` validation).
   */
  private async finalize(
    trackId: string,
    contentType: string | undefined,
    meta: TaskMeta,
  ): Promise<void> {
    try {
      const part = new File(this.dir, `${sanitizeId(trackId)}.part`);
      if (!part.exists) {
        this.fail(trackId, "Download finished but the file is missing");
        return;
      }

      const handle = part.open();
      const head = handle.readBytes(16);
      handle.close();
      if (
        isRejectedStreamContentType(contentType) ||
        !looksLikeMediaBytes(head, contentType)
      ) {
        try {
          part.delete();
        } catch {
          // Overwritten by the next attempt.
        }
        this.fail(trackId, "Downloaded stream was not a valid audio file.");
        return;
      }

      const ext =
        extensionForContentType(contentType) ??
        extensionForMediaBytes(head) ??
        DEFAULT_EXTENSION;
      const filename = `${sanitizeId(trackId)}.${ext}`;
      const file = new File(this.dir, filename);
      if (file.exists) file.delete();
      await part.move(file);

      // Cover art is best-effort: a missing/failed cover must not fail the
      // audio download, so this never throws.
      const coverFilename = meta.track
        ? await this.downloadCover(meta.track)
        : undefined;

      const owners = [
        ...new Set([
          ...(this.pendingOwners.get(trackId) ?? []),
          ...(meta.owners ?? []),
        ]),
      ];
      this.records.set(trackId, {
        trackId,
        filename,
        size: file.size || 0,
        downloadedAt: Date.now(),
        owners: owners.length ? owners : ["track"],
        coverFilename,
        track: meta.track,
      });
      await this.persist();
      this.active.delete(trackId);
      this.pendingOwners.delete(trackId);
      this.errors.delete(trackId);
      this.emit();
      // Runs on background wakes too — this is the Live Activity's only
      // update beat while the app is suspended.
      downloadLiveActivity.noteDone(trackId);
    } catch (error) {
      this.fail(
        trackId,
        error instanceof Error ? error.message : "Download failed",
      );
    }
  }

  /** Record a per-track failure. Task callbacks have no awaiter to reject,
   *  so errors surface through `phaseFor`/`errorFor` subscribers only. */
  private fail(trackId: string, message: string): void {
    this.errors.set(trackId, message);
    this.active.delete(trackId);
    this.pendingOwners.delete(trackId);
    this.emit();
    downloadLiveActivity.noteFailed(trackId);
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
   * Enqueue background downloads for every track of a playlist under a
   * `playlist:<id>` owner. Resolves when all tasks are ENQUEUED — completion
   * is observed via store subscription; the native layers manage their own
   * concurrency. Per-track failures are swallowed so one bad track never
   * aborts the batch.
   */
  async downloadPlaylist(
    playlistId: string,
    tracks: TrackListItem[],
    options?: { playlistName?: string },
  ): Promise<void> {
    await this.hydrate();
    // Only tracks that will actually transfer belong to the Live Activity
    // session (an empty list means it never starts). Tracks already in
    // flight from an earlier tap are included — the session dedupes them and
    // their completion callbacks still land.
    const pending = tracks.filter((track) => !this.records.has(track.id));
    downloadLiveActivity.begin(options?.playlistName ?? "Playlist", pending);
    const owner = playlistOwner(playlistId);
    for (const track of tracks) {
      try {
        await this.downloadTrack(track, owner);
      } catch {
        // Already recorded as a per-track error; keep enqueueing the rest.
      }
    }
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

  /**
   * Backfill offline snapshots for already-downloaded tracks whose records
   * predate the `track` field. Called by screens when fresh list data flows
   * through them, so old downloads self-heal without a re-download press.
   */
  noteTracks(tracks: TrackListItem[]): void {
    let mutated = false;
    for (const track of tracks) {
      const record = this.records.get(track.id);
      if (record && !record.track) {
        record.track = track;
        mutated = true;
      }
    }
    if (mutated) {
      void this.persist();
      this.emit();
    }
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
      // `cover_url` can be a server- (or upstream-TIDAL-) supplied absolute URL,
      // so credentials only go to our own origin. Off-origin artwork is still
      // fetched, just anonymously.
      const coverUrl = trackCoverUrl(track, COVER_SIZE);
      const response = await fetch(coverUrl, {
        credentials: isApiOrigin(coverUrl) ? "include" : "omit",
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

/** Metadata attached to native download tasks; restored (best-effort) by
 *  `getExistingDownloadTasks()` after a process death. */
interface TaskMeta {
  owners?: DownloadOwner[];
  /** Snapshot persisted onto the record by `finalize`; also the source of
   *  the cover fields. May be absent on tasks restored after a restart. */
  track?: TrackListItem;
}

/**
 * All cookies for the API origin as one `Cookie` header. The native
 * downloaders (notably Android's DownloadManager) don't share RN's cookie
 * jar, so the session cookie must be attached explicitly for
 * `/api/tracks/{id}/stream` to authenticate.
 */
async function sessionCookieHeader(): Promise<Record<string, string>> {
  try {
    const cookies = await CookieManager.get(getBaseUrl());
    const pairs = Object.values(cookies).map((c) => `${c.name}=${c.value}`);
    return pairs.length ? { Cookie: pairs.join("; ") } : {};
  } catch {
    return {}; // No cookie -> the server 401s -> finalize rejects the body.
  }
}

/** Case-insensitive response-header lookup. */
function headerValue(
  headers: Record<string, string | null>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && value != null) return value;
  }
  return undefined;
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
