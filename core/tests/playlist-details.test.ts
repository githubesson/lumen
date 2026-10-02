import { describe, expect, it } from "vitest";
import {
  PLAYLIST_COVER_MAX_BYTES,
  isValidPlaylistName,
  playlistCoverSizeError,
  playlistDetailsPayload,
  playlistSubtitle,
  samePlaylistDetails,
} from "../src/playlist-details";

describe("playlistDetailsPayload", () => {
  it("trims the name and the description", () => {
    expect(
      playlistDetailsPayload({
        name: "  Road trip ",
        description: "  Long drives\n",
        visibility: "collaborative",
      }),
    ).toEqual({ name: "Road trip", description: "Long drives", visibility: "collaborative" });
  });

  it("sends an absent description as empty", () => {
    expect(playlistDetailsPayload({ name: "Mix", visibility: "private" }).description).toBe("");
    expect(
      playlistDetailsPayload({ name: "Mix", description: null, visibility: "private" }).description,
    ).toBe("");
  });
});

describe("isValidPlaylistName", () => {
  it("rejects blank and whitespace-only names, like the server", () => {
    expect(isValidPlaylistName("")).toBe(false);
    expect(isValidPlaylistName("   \t")).toBe(false);
    expect(isValidPlaylistName(" a ")).toBe(true);
  });
});

describe("samePlaylistDetails", () => {
  it("ignores whitespace that saving would trim", () => {
    const saved = { name: "Mix", description: "Notes", visibility: "private" as const };
    expect(samePlaylistDetails(saved, { ...saved, name: "Mix " })).toBe(true);
    expect(samePlaylistDetails(saved, { ...saved, description: " Notes " })).toBe(true);
    expect(samePlaylistDetails(saved, { ...saved, visibility: "collaborative" })).toBe(false);
    expect(samePlaylistDetails(saved, { ...saved, description: "Other" })).toBe(false);
  });
});

describe("playlistCoverSizeError", () => {
  it("matches the server's 16 MB cap", () => {
    expect(PLAYLIST_COVER_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(playlistCoverSizeError(PLAYLIST_COVER_MAX_BYTES)).toBeNull();
    expect(playlistCoverSizeError(PLAYLIST_COVER_MAX_BYTES + 1)).toMatch(/over 16 MB/);
  });

  it("lets an unknown size through to the server", () => {
    expect(playlistCoverSizeError(undefined)).toBeNull();
    expect(playlistCoverSizeError(null)).toBeNull();
    expect(playlistCoverSizeError(Number.NaN)).toBeNull();
  });
});

describe("playlistSubtitle", () => {
  it("shows visibility, then your role when the playlist isn't yours", () => {
    expect(playlistSubtitle({ visibility: "private", effective_role: "owner" })).toBe("Private");
    expect(playlistSubtitle({ visibility: "collaborative", effective_role: "owner" })).toBe(
      "Collaborative",
    );
    expect(playlistSubtitle({ visibility: "collaborative", effective_role: "editor" })).toBe(
      "Collaborative · editor",
    );
    expect(playlistSubtitle({ visibility: "collaborative", effective_role: "viewer" })).toBe(
      "Collaborative · viewer",
    );
  });

  it("shows just the visibility when the role is missing", () => {
    expect(playlistSubtitle({ visibility: "collaborative" })).toBe("Collaborative");
    expect(playlistSubtitle({ visibility: "private", effective_role: "" })).toBe("Private");
  });
});
