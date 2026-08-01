/**
 * Tests for the on-disk diagnostics log. The filesystem is faked in memory
 * with append-aware writes, since append semantics, rotation, and tolerance of
 * a torn final line are the whole point of the module.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import type { LogEntry } from "../lib/diagnostics/log";

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
  DOC: "file:///docs",
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
    readonly uri: string;
    constructor(dir: FakeDirectory, name: string) {
      this.uri = `${dir.uri}/${name}`;
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
      h.files.set(this.uri, "");
    }
    write(content: string, options?: { append?: boolean }) {
      const previous = options?.append ? (h.files.get(this.uri) ?? "") : "";
      h.files.set(this.uri, previous + content);
    }
    textSync() {
      const text = h.files.get(this.uri);
      if (text === undefined) throw new Error("No such file");
      return text;
    }
    moveSync(destination: FakeFile) {
      h.files.set(destination.uri, h.files.get(this.uri) ?? "");
      h.files.delete(this.uri);
    }
    delete() {
      h.files.delete(this.uri);
    }
  }
  return {
    Directory: FakeDirectory,
    File: FakeFile,
    Paths: { document: new FakeDirectory(h.DOC) },
  };
});

type LogModule = typeof import("../lib/diagnostics/log");
let log: LogModule["diagnosticsLog"];

const CURRENT = `${h.DOC}/diagnostics/log.jsonl`;
const ARCHIVE = `${h.DOC}/diagnostics/log.1.jsonl`;

beforeEach(async () => {
  h.files.clear();
  h.dirs.clear();
  // A fresh module gives each test its own session-header and dedupe state.
  vi.resetModules();
  ({ diagnosticsLog: log } = await import("../lib/diagnostics/log"));
});

afterEach(() => {
  vi.useRealTimers();
});

/** Entries excluding the once-per-process session header. */
function events(entries: LogEntry[]): LogEntry[] {
  return entries.filter((entry) => entry.event !== "session-start");
}

describe("diagnosticsLog", () => {
  it("appends entries and reads them back newest first", () => {
    log.append({
      scope: "download",
      level: "error",
      event: "not-audio",
      message: "first",
    });
    log.append({
      scope: "download",
      level: "info",
      event: "downloaded",
      message: "second",
    });

    const entries = events(log.read());
    expect(entries.map((e) => e.message)).toEqual(["second", "first"]);
    expect(entries[0]?.v).toBe(1);
    expect(entries[0]?.at).toBeTypeOf("number");
  });

  it("writes the session header once, ahead of the first entry", () => {
    log.configure({ describeBuild: () => "1.2.3 · ios 18" });
    log.append({
      scope: "download",
      level: "info",
      event: "a",
      message: "a",
    });
    log.append({
      scope: "download",
      level: "info",
      event: "b",
      message: "b",
    });

    const all = log.read();
    const headers = all.filter((e) => e.event === "session-start");
    expect(headers).toHaveLength(1);
    expect(headers[0]?.message).toBe("1.2.3 · ios 18");
    // Oldest entry, so last in a newest-first list.
    expect(all[all.length - 1]?.event).toBe("session-start");
  });

  it("stamps injected context onto every entry", () => {
    log.configure({
      context: () => ({ net: "offline", appState: "background" }),
    });
    log.append({
      scope: "download",
      level: "error",
      event: "task-error",
      message: "boom",
    });

    const [entry] = events(log.read());
    expect(entry?.net).toBe("offline");
    expect(entry?.appState).toBe("background");
  });

  it("collapses repeats inside the window and reports the attempt count", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T10:00:00Z"));
    const entry = {
      scope: "download",
      level: "error",
      event: "not-audio",
      message: "Downloaded stream was not a valid audio file.",
      trackId: "track-1",
    } as const;

    log.append(entry);
    for (let i = 0; i < 5; i += 1) log.append(entry);
    expect(events(log.read())).toHaveLength(1);

    // Past the window the next occurrence is written, carrying the count of
    // everything the window swallowed plus itself.
    vi.setSystemTime(new Date("2026-08-01T10:06:00Z"));
    log.append(entry);

    const written = events(log.read());
    expect(written).toHaveLength(2);
    expect(written[0]?.attempt).toBe(6);
    expect(written[1]?.attempt).toBeUndefined();
  });

  it("keeps distinct failures separate while collapsing", () => {
    const base = { scope: "download", level: "error", event: "not-audio" } as const;
    log.append({ ...base, message: "m", trackId: "a" });
    log.append({ ...base, message: "m", trackId: "a" });
    log.append({ ...base, message: "m", trackId: "b" });

    expect(events(log.read()).map((e) => e.trackId)).toEqual(["b", "a"]);
  });

  it("rotates past the cap and still reads both files", () => {
    log.append({
      scope: "download",
      level: "info",
      event: "old",
      message: "oldest",
    });
    // One oversized entry pushes the file past the rotation threshold.
    log.append({
      scope: "download",
      level: "info",
      event: "bulky",
      message: "x".repeat(600 * 1024),
    });
    expect(h.files.has(ARCHIVE)).toBe(false);

    log.append({
      scope: "download",
      level: "error",
      event: "new",
      message: "newest",
    });

    expect(h.files.has(ARCHIVE)).toBe(true);
    expect(h.files.get(CURRENT)).toContain("newest");
    expect(h.files.get(CURRENT)).not.toContain("oldest");
    expect(events(log.read()).map((e) => e.event)).toEqual([
      "new",
      "bulky",
      "old",
    ]);
  });

  it("skips a torn line rather than losing the file", () => {
    log.append({
      scope: "download",
      level: "error",
      event: "good",
      message: "intact",
    });
    // A process killed mid-append leaves a partial final line.
    h.files.set(CURRENT, `${h.files.get(CURRENT)}{"v":1,"at":123,"sco`);

    const entries = events(log.read());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toBe("intact");
  });

  it("counts warnings and errors without parsing", () => {
    log.append({ scope: "download", level: "error", event: "e", message: "e" });
    log.append({ scope: "cover", level: "warn", event: "w", message: "w" });
    log.append({ scope: "download", level: "info", event: "i", message: "i" });

    // The session header is an info line, so it doesn't count either.
    expect(log.problemCount()).toBe(2);
  });

  it("does not miscount a body that quotes a log line", () => {
    log.append({
      scope: "download",
      level: "error",
      event: "not-audio",
      message: "bad",
      body: '{"level":"error"} from the server',
    });

    expect(log.problemCount()).toBe(1);
  });

  it("clears both files and re-identifies the build afterwards", () => {
    log.configure({ describeBuild: () => "build-a" });
    log.append({ scope: "download", level: "error", event: "e", message: "e" });
    expect(log.read().length).toBeGreaterThan(0);

    log.clear();
    expect(log.read()).toEqual([]);
    expect(log.sizeBytes()).toBe(0);

    log.append({ scope: "download", level: "error", event: "f", message: "f" });
    expect(log.read().some((e) => e.event === "session-start")).toBe(true);
  });

  it("never throws when the filesystem refuses to write", () => {
    h.dirs.add(`${h.DOC}/diagnostics`);
    h.files.set(CURRENT, "");
    const file = h.files;
    const original = file.set.bind(file);
    file.set = () => {
      throw new Error("disk full");
    };

    expect(() =>
      log.append({
        scope: "download",
        level: "error",
        event: "e",
        message: "e",
      }),
    ).not.toThrow();

    file.set = original;
  });
});

describe("asciiSnippet", () => {
  it("renders a server error body and masks non-printable bytes", async () => {
    const { asciiSnippet } = await import("../lib/diagnostics/log");
    const bytes = new Uint8Array([
      0x66, 0x6f, 0x72, 0x62, 0x69, 0x64, 0x64, 0x65, 0x6e, 0x00, 0xff,
    ]);
    expect(asciiSnippet(bytes)).toBe("forbidden..");
  });

  it("truncates to the requested length", async () => {
    const { asciiSnippet } = await import("../lib/diagnostics/log");
    const bytes = new Uint8Array(64).fill(0x61);
    expect(asciiSnippet(bytes, 8)).toBe("aaaaaaaa");
  });
});
