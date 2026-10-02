import { describe, expect, it } from "vitest";
import type { MusicRoot } from "../src/api";
import {
  addMusicRootInput,
  canManageMusicRoot,
  musicRootKey,
  musicRootName,
  musicRootRemoval,
  rescanChangedLibrary,
  rootRemovalChangedLibrary,
} from "../src/admin/music-roots";

function root(overrides: Partial<MusicRoot> = {}): MusicRoot {
  return {
    id: "8d3c2a52-6c43-4c43-9d55-8d5b0f1f7e10",
    path: "/mnt/external/flac",
    label: "",
    enabled: true,
    primary: false,
    exists: true,
    ...overrides,
  };
}

// As GET /api/admin/library/roots returns MUSIC_PATH.
const primary = root({
  id: "",
  path: "/music",
  label: "Primary (MUSIC_PATH)",
  primary: true,
});

describe("music root display", () => {
  it("names the primary root, then labels, then the folder name", () => {
    expect(musicRootName(primary)).toBe("Primary");
    expect(musicRootName(root({ label: "External" }))).toBe("External");
    expect(musicRootName(root())).toBe("flac");
    expect(musicRootName(root({ path: "/mnt/external/flac/" }))).toBe("flac");
    expect(musicRootName(root({ path: "D:\\Music\\Lossless" }))).toBe("Lossless");
    expect(musicRootName(root({ path: "/" }))).toBe("/");
  });

  it("keys rows uniquely even though the primary root has no id", () => {
    const rows = [primary, root(), root({ id: "other", path: "/other" })];
    const keys = rows.map(musicRootKey);
    expect(new Set(keys).size).toBe(rows.length);
    expect(keys).not.toContain("");
    expect(musicRootKey(root())).toBe(root().id);
  });

  it("only lets a configured root be paused or removed", () => {
    expect(canManageMusicRoot(primary)).toBe(false);
    expect(canManageMusicRoot(root())).toBe(true);
    // An id-less row has nothing for the API to address.
    expect(canManageMusicRoot(root({ id: "" }))).toBe(false);
  });
});

describe("music root removal", () => {
  it("offers purging only for a root no other watched root covers", () => {
    expect(musicRootRemoval(root())).toEqual({ canPurge: true, coveredBy: null });
    expect(musicRootRemoval(root({ covered_by: "" }))).toEqual({
      canPurge: true,
      coveredBy: null,
    });
    expect(musicRootRemoval(root({ covered_by: "/music" }))).toEqual({
      canPurge: false,
      coveredBy: "/music",
    });
  });

  it("changes the library only when tracks were purged", () => {
    expect(rootRemovalChangedLibrary({ purged: true, deletedTracks: 3 })).toBe(true);
    expect(rootRemovalChangedLibrary({ purged: true, deletedTracks: 0 })).toBe(false);
    expect(
      rootRemovalChangedLibrary({ purged: true, deletedTracks: undefined }),
    ).toBe(false);
    expect(rootRemovalChangedLibrary({ purged: false, deletedTracks: 3 })).toBe(
      false,
    );
  });
});

describe("finished rescans", () => {
  it("changed the library when they went through or pruned files", () => {
    expect(rescanChangedLibrary({ running: false, processed: 10 })).toBe(true);
    expect(
      rescanChangedLibrary({ running: false, processed: 0, pruned: 2 }),
    ).toBe(true);
  });

  it("did not when they found nothing, are still running, or are unknown", () => {
    expect(rescanChangedLibrary({ running: false })).toBe(false);
    expect(
      rescanChangedLibrary({ running: false, processed: 0, pruned: 0 }),
    ).toBe(false);
    expect(rescanChangedLibrary({ running: true, processed: 10 })).toBe(false);
    expect(rescanChangedLibrary(null)).toBe(false);
    expect(rescanChangedLibrary(undefined)).toBe(false);
  });
});

describe("adding a root", () => {
  it("trims the path and omits a blank label", () => {
    expect(addMusicRootInput("  /mnt/flac ", "  ")).toEqual({ path: "/mnt/flac" });
    expect(addMusicRootInput("/mnt/flac", " External ")).toEqual({
      path: "/mnt/flac",
      label: "External",
    });
  });

  it("has nothing to send without a path", () => {
    expect(addMusicRootInput("   ", "External")).toBeNull();
  });
});
