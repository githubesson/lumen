import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, type LyricsResult, type TrackListItem } from "@music-library/core";
import PlayerLyricsLine from "../src/components/PlayerLyricsLine";
import { useTrackLyrics } from "../src/lib/useTrackLyrics";

const mock = vi.hoisted(() => ({ getLyrics: vi.fn() }));
vi.mock("../src/api", async (original) => ({
  ...(await original<typeof import("../src/api")>()),
  api: { getLyrics: mock.getLyrics },
}));

// The lyrics cache is module state: every test uses its own track.
const track = (id: string): TrackListItem => ({
  id,
  title: "Song",
  artist: "Artist",
  album_title: "Album",
  duration_ms: 181_600,
});
const instrumental: LyricsResult = {
  id: 1,
  trackName: "Song",
  artistName: "Artist",
  instrumental: true,
  syncedLyrics: null,
  plainLyrics: null,
};

beforeEach(() => {
  mock.getLyrics.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function load(id: string) {
  const hook = renderHook(() => useTrackLyrics(track(id), true));
  await act(async () => {});
  return hook.result.current;
}

it("asks for the track's metadata with its duration in seconds", async () => {
  mock.getLyrics.mockResolvedValueOnce(instrumental);
  await load("request");
  expect(mock.getLyrics).toHaveBeenCalledWith({
    track_name: "Song",
    artist_name: "Artist",
    album_name: "Album",
    duration: 182,
  });
});

it("shows an instrumental result as Instrumental, not as missing lyrics", async () => {
  mock.getLyrics.mockResolvedValueOnce(instrumental);
  const { lyrics, error } = await load("instrumental");
  expect(error).toBeNull();
  render(
    <PlayerLyricsLine
      variant="sidebar"
      lyrics={lyrics}
      loading={false}
      error={error}
      currentTime={0}
      durationSeconds={180}
    />,
  );
  expect(screen.getByText("Instrumental")).toBeTruthy();
  expect(screen.queryByText("No lyrics found")).toBeNull();
});

it("reports the server's 404 as no lyrics and other failures as a load error", async () => {
  mock.getLyrics.mockRejectedValueOnce(new ApiError(404, "lyrics_not_found"));
  expect((await load("missing")).error).toBe("No lyrics found");
  mock.getLyrics.mockRejectedValueOnce(new ApiError(502, "bad gateway"));
  expect((await load("broken")).error).toBe("Couldn't load lyrics");
});

it("still treats a result without any text as no lyrics", async () => {
  mock.getLyrics.mockResolvedValueOnce({ ...instrumental, instrumental: false, plainLyrics: " " });
  expect(await load("blank")).toMatchObject({ lyrics: null, error: "No lyrics found" });
});
