import { describe, expect, it } from "vitest";
import type { UploadResult } from "../src/api";
import {
  UPLOAD_REQUEST_MAX_BYTES,
  defaultUploadScope,
  isUploadableFile,
  planUploadBatches,
  summarizeUploadResults,
  tooLargeUploadResult,
  uploadAddedAny,
  uploadResultDetail,
  uploadResultStatus,
  uploadStatusLabel,
  uploadScope,
  uploadSummaryLabel,
} from "../src/upload";

const result = (over: Partial<UploadResult>): UploadResult => ({
  file: "a.mp3",
  inserted: false,
  ...over,
});

describe("uploadResultStatus", () => {
  it("follows the server's precedence: error, then skipped, then inserted", () => {
    expect(uploadResultStatus(result({ error: "storage quota exceeded", inserted: true }))).toBe("failed");
    expect(uploadResultStatus(result({ skipped: true, inserted: true }))).toBe("skipped");
    expect(uploadResultStatus(result({ inserted: true, dedup: true }))).toBe("added");
    expect(uploadResultStatus(result({ dedup: true }))).toBe("duplicate");
  });

  it("reads a result with no flags as a duplicate, as the server's summary does", () => {
    expect(uploadResultStatus(result({}))).toBe("duplicate");
  });
});

describe("upload labels", () => {
  it("names every status", () => {
    expect(uploadStatusLabel("added")).toBe("Added");
    expect(uploadStatusLabel("duplicate")).toBe("Already in library");
    expect(uploadStatusLabel("skipped")).toBe("Skipped (unsupported format)");
    expect(uploadStatusLabel("failed")).toBe("Failed");
  });

  it("puts the server's error first in a file's detail line", () => {
    expect(uploadResultDetail(result({ error: "file too large" }))).toBe("file too large");
    expect(uploadResultDetail(result({ inserted: true }))).toBe("Added");
  });

  it("summarizes a batch without counting a file twice", () => {
    const summary = summarizeUploadResults([
      result({ inserted: true }),
      result({ inserted: true }),
      result({ dedup: true }),
      result({ skipped: true }),
      result({ error: "boom", inserted: true }),
    ]);
    expect(summary).toEqual({ added: 2, duplicate: 1, skipped: 1, failed: 1 });
    expect(uploadSummaryLabel(summary)).toBe(
      "2 added · 1 already in library · 1 skipped · 1 failed",
    );
  });

  it("leaves out what didn't happen", () => {
    expect(uploadSummaryLabel(summarizeUploadResults([result({ inserted: true })]))).toBe("1 added");
    expect(uploadSummaryLabel(summarizeUploadResults([]))).toBe("No files uploaded");
  });
});

describe("uploadAddedAny", () => {
  it("is true only when something was inserted", () => {
    expect(uploadAddedAny([result({ dedup: true }), result({ skipped: true })])).toBe(false);
    expect(uploadAddedAny([result({ error: "boom" })])).toBe(false);
    expect(uploadAddedAny([result({ dedup: true }), result({ inserted: true })])).toBe(true);
    expect(uploadAddedAny([])).toBe(false);
  });
});

describe("defaultUploadScope", () => {
  it("defaults admins to the shared library and everyone else to personal", () => {
    expect(defaultUploadScope(true)).toBe("global");
    expect(defaultUploadScope(false)).toBe("personal");
  });
});

describe("uploadScope", () => {
  it("sends an admin's choice and everyone else's uploads as personal", () => {
    expect(uploadScope(true, "global")).toBe("global");
    expect(uploadScope(true, "personal")).toBe("personal");
    expect(uploadScope(false, "global")).toBe("personal");
  });
});

describe("isUploadableFile", () => {
  it("accepts the extensions the server ingests, in any case", () => {
    for (const name of ["a.mp3", "b.FLAC", "c.m4a", "d.mp4", "e.ogg", "f.opus", "g.wav", "h.aac", "i.webm", "j.k.Mp3"]) {
      expect(isUploadableFile(name)).toBe(true);
    }
  });

  it("refuses what the server would skip", () => {
    for (const name of ["a.aiff", "b.wma", "c.alac", "d.oga", "e.txt", "mp3", "dir.mp3/file", ""]) {
      expect(isUploadableFile(name)).toBe(false);
    }
  });
});

describe("planUploadBatches", () => {
  const MiB = 1 << 20;
  const file = (name: string, size?: number) => ({ name, size });
  const plan = (files: { name: string; size?: number }[], max?: number) => {
    const { batches, tooLarge } = planUploadBatches(files, (f) => f.size, max);
    return {
      batches: batches.map((batch) => batch.map((f) => f.name)),
      tooLarge: tooLarge.map((f) => f.name),
    };
  };

  it("keeps a selection under the cap in one request", () => {
    expect(plan([file("a", 10 * MiB), file("b", 20 * MiB)])).toEqual({ batches: [["a", "b"]], tooLarge: [] });
    expect(plan([])).toEqual({ batches: [], tooLarge: [] });
  });

  it("starts a new request before one would pass the cap, keeping the order", () => {
    expect(plan([file("a", 300 * MiB), file("b", 300 * MiB), file("c", 100 * MiB), file("d", 400 * MiB)])).toEqual({
      batches: [["a"], ["b", "c"], ["d"]],
      tooLarge: [],
    });
  });

  it("leaves room for the multipart form around the files", () => {
    expect(plan([file("a", 256 * MiB), file("b", 256 * MiB)]).batches).toEqual([["a"], ["b"]]);
    expect(plan([file("whole", UPLOAD_REQUEST_MAX_BYTES)])).toEqual({ batches: [], tooLarge: ["whole"] });
  });

  it("reports files too large to send at all, and sends the rest", () => {
    expect(plan([file("a", 1 * MiB), file("huge", 600 * MiB), file("b", 1 * MiB)])).toEqual({
      batches: [["a", "b"]],
      tooLarge: ["huge"],
    });
  });

  it("sends a file of unknown size alone", () => {
    expect(plan([file("a", 1), file("unknown"), file("b", 1)])).toEqual({
      batches: [["a"], ["unknown"], ["b"]],
      tooLarge: [],
    });
  });

  it("takes a smaller cap", () => {
    expect(plan([file("a", 100 * 1024), file("b", 100 * 1024)], 256 * 1024).batches).toEqual([["a"], ["b"]]);
  });
});

describe("tooLargeUploadResult", () => {
  it("reads as a failure with the server's wording", () => {
    const refused = tooLargeUploadResult("huge.flac");
    expect(uploadResultStatus(refused)).toBe("failed");
    expect(uploadResultDetail(refused)).toBe("file too large");
    expect(summarizeUploadResults([refused, result({ inserted: true })])).toEqual({ added: 1, duplicate: 0, skipped: 0, failed: 1 });
  });
});
