import { describe, expect, it } from "vitest";
import type { UploadResult } from "../src/api";
import {
  defaultUploadScope,
  summarizeUploadResults,
  uploadAddedAny,
  uploadResultDetail,
  uploadResultStatus,
  uploadStatusLabel,
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
