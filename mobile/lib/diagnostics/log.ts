import { Directory, File, Paths } from "expo-file-system";

/**
 * On-disk diagnostics log — the thing you read when a download keeps failing
 * and the app is not in front of you.
 *
 * JSONL, append-only. `File.write(..., { append: true })` is a *synchronous*
 * native append, which is the whole reason this lives on disk rather than in
 * AsyncStorage: failures are reported from native background-download
 * callbacks, and iOS can suspend the process the moment one returns. A sync
 * append has always landed by then; an awaited AsyncStorage write (which also
 * rewrites the entire blob) can be cut off mid-flight.
 *
 * Entries are structured objects, not formatted strings, so the viewer can
 * filter and group them and new fields can be added without invalidating old
 * lines — hence the `v` stamp on every entry.
 *
 * Nothing here may throw: a log write failing must never fail a download.
 *
 * Ambient context (connectivity, app lifecycle, build identity) is injected by
 * `DownloadsProvider` rather than imported. That keeps this module's only
 * dependency `expo-file-system`, so the stores that log can still be unit
 * tested against an in-memory filesystem.
 */

const DIR_NAME = "diagnostics";
const CURRENT = "log.jsonl";
const ARCHIVE = "log.1.jsonl";
/** Rotate past this; with one archive the log is bounded at roughly twice it. */
const MAX_BYTES = 512 * 1024;
/**
 * A repeating failure is one line plus a count, not one line per attempt.
 * Auto-download re-enqueues every missing track on each foreground, reconnect
 * and playlist render, so without this a single broken track would push
 * everything else out of the file within a day.
 */
const DUPLICATE_WINDOW_MS = 5 * 60_000;
/** Keeps the suppression map from growing with a large library. */
const SUPPRESS_PRUNE_AT = 400;
/** Server error bodies are captured to diagnose, not to archive. */
export const BODY_PROBE_BYTES = 512;
const ENTRY_VERSION = 1;

export type LogScope =
  | "download"
  | "auto-sync"
  | "cover"
  | "store"
  | "session"
  | "siri";
export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  /** Entry schema version; old lines stay parseable as fields are added. */
  v: number;
  at: number;
  scope: LogScope;
  level: LogLevel;
  /** Stable machine-readable key (`task-error`, `not-audio`, …) — the viewer
   *  groups on this, so it must not embed variable detail. */
  event: string;
  message: string;
  trackId?: string;
  /** "Artist — Title" at the time of the attempt. */
  title?: string;
  source?: string;
  playlistId?: string;
  owner?: string;
  url?: string;
  /** Only present on `fetch`-based paths — the native downloader never
   *  surfaces the HTTP status, which is why bodies are quoted instead. */
  status?: number;
  contentType?: string;
  bytes?: number;
  /** Native downloader error code (NSURLError / DownloadManager reason). */
  errorCode?: number;
  /** Quoted head of a response that wasn't audio — usually the server's own
   *  error text, which is the fastest route to the matching server log line. */
  body?: string;
  /** Attempts collapsed into this line, when duplicates were suppressed. */
  attempt?: number;
  net?: "online" | "offline";
  /** App lifecycle at the time of the entry — `background` is how you tell a
   *  failure happened during an unattended sync. */
  appState?: string;
}

export type LogInput = Omit<
  LogEntry,
  "v" | "at" | "attempt" | "net" | "appState"
>;

/** Ambient state stamped onto every entry, supplied by the host app. */
export interface LogContext {
  net?: "online" | "offline";
  appState?: string;
}

type Listener = () => void;

class DiagnosticsLog {
  private listeners = new Set<Listener>();
  private version = 0;
  /** key -> when the window closes, and how many hits it swallowed. */
  private suppressed = new Map<string, { until: number; count: number }>();
  private sessionLogged = false;
  private context: (() => LogContext) | null = null;
  private describeBuild: (() => string) | null = null;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = (): number => this.version;

  /**
   * Supply the ambient state stamped onto each entry — read at write time, so
   * an entry recorded from a background callback reports the state it actually
   * happened in.
   *
   * `describeBuild` produces the one-per-process session line. Both are
   * injected because they come from `react-native` / `expo-updates`, which the
   * stores that call into here must stay unit-testable without.
   */
  configure(options: {
    context?: () => LogContext;
    describeBuild?: () => string;
  }): void {
    if (options.context) this.context = options.context;
    if (options.describeBuild) this.describeBuild = options.describeBuild;
  }

  /** Record one event. Safe to call from any thread/callback; never throws. */
  append(input: LogInput): void {
    try {
      const now = Date.now();
      const key = `${input.event}|${input.trackId ?? ""}|${input.message}`;
      const seen = this.suppressed.get(key);
      if (seen && now < seen.until) {
        seen.count += 1;
        return;
      }
      const attempt = seen && seen.count > 0 ? seen.count + 1 : undefined;
      this.suppressed.set(key, { until: now + DUPLICATE_WINDOW_MS, count: 0 });
      if (this.suppressed.size > SUPPRESS_PRUNE_AT) this.prune(now);

      this.writeSessionHeader();
      this.write({
        ...input,
        ...this.context?.(),
        v: ENTRY_VERSION,
        at: now,
        attempt,
      });
    } catch {
      // Diagnostics must never take a download down with them.
    }
  }

  /** Every entry on disk, newest first. Parses synchronously — call it from an
   *  effect, not from render. */
  read(): LogEntry[] {
    const entries: LogEntry[] = [];
    // Oldest file first so the combined list is chronological before the flip.
    for (const name of [ARCHIVE, CURRENT]) {
      try {
        const file = new File(this.dir, name);
        if (!file.exists) continue;
        for (const line of file.textSync().split("\n")) {
          if (!line) continue;
          try {
            entries.push(JSON.parse(line) as LogEntry);
          } catch {
            // A process killed mid-append leaves one torn line; skip it.
          }
        }
      } catch {
        // Unreadable file — show whatever the other one has.
      }
    }
    return entries.reverse();
  }

  /**
   * How many recorded events are warnings or errors, counted by scanning the
   * raw text rather than parsing every line — cheap enough for a badge on a
   * settings row. A body that happens to contain the same text can't inflate
   * this: nested quotes are backslash-escaped by `JSON.stringify`.
   */
  problemCount(): number {
    let total = 0;
    for (const name of [CURRENT, ARCHIVE]) {
      try {
        const file = new File(this.dir, name);
        if (!file.exists) continue;
        const text = file.textSync();
        total += occurrences(text, '"level":"error"');
        total += occurrences(text, '"level":"warn"');
      } catch {
        // Unreadable file contributes nothing.
      }
    }
    return total;
  }

  /** Bytes on disk across both files. Cheap enough for a settings row. */
  sizeBytes(): number {
    let total = 0;
    for (const name of [CURRENT, ARCHIVE]) {
      try {
        total += new File(this.dir, name).size || 0;
      } catch {
        // Missing file contributes nothing.
      }
    }
    return total;
  }

  /** Drop everything. The next entry re-writes the session header, so a
   *  cleared log still identifies the build it came from. */
  clear(): void {
    for (const name of [CURRENT, ARCHIVE]) {
      try {
        const file = new File(this.dir, name);
        if (file.exists) file.delete();
      } catch {
        // Best effort; a file we can't delete is still capped by rotation.
      }
    }
    this.suppressed.clear();
    this.sessionLogged = false;
    this.emit();
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private get dir(): Directory {
    return new Directory(Paths.document, DIR_NAME);
  }

  private currentFile(): File {
    const dir = this.dir;
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const file = new File(dir, CURRENT);
    if (!file.exists) file.create({ intermediates: true });
    return file;
  }

  private write(entry: LogEntry): void {
    let file = this.currentFile();
    if (file.size > MAX_BYTES) {
      this.rotate();
      file = this.currentFile();
    }
    file.write(`${JSON.stringify(entry)}\n`, { append: true });
    this.emit();
  }

  private rotate(): void {
    const dir = this.dir;
    try {
      const archive = new File(dir, ARCHIVE);
      if (archive.exists) archive.delete();
      new File(dir, CURRENT).moveSync(archive);
    } catch {
      // If the archive swap fails, drop the current file rather than letting
      // it grow without bound.
      try {
        const file = new File(dir, CURRENT);
        if (file.exists) file.delete();
      } catch {
        // Nothing further to try.
      }
    }
  }

  /** One line per process describing the build, so a copied-out log is
   *  self-identifying without repeating this on every entry. */
  private writeSessionHeader(): void {
    if (this.sessionLogged) return;
    this.sessionLogged = true;
    this.write({
      ...this.context?.(),
      v: ENTRY_VERSION,
      at: Date.now(),
      scope: "session",
      level: "info",
      event: "session-start",
      message: this.describeBuild?.() ?? "unidentified build",
    });
  }

  private prune(now: number): void {
    for (const [key, value] of this.suppressed) {
      if (value.until <= now) this.suppressed.delete(key);
    }
  }

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

export const diagnosticsLog = new DiagnosticsLog();

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Printable-ASCII rendering of a response head. Server errors here are plain
 * text ("not found", "file missing on disk"), and decoding them this way avoids
 * depending on `TextDecoder`, which isn't guaranteed across Hermes versions.
 */
export function asciiSnippet(
  bytes: Uint8Array,
  max = BODY_PROBE_BYTES,
): string {
  const limit = Math.min(bytes.length, max);
  let out = "";
  for (let i = 0; i < limit; i += 1) {
    const byte = bytes[i]!;
    out += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".";
  }
  return out.trim();
}

/** Short human label for a track, for log lines and the viewer. */
export function trackLabel(track?: {
  title?: string;
  artist?: string;
}): string | undefined {
  if (!track?.title) return undefined;
  return track.artist ? `${track.artist} — ${track.title}` : track.title;
}
