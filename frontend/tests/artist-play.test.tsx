import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TrackListItem } from "@music-library/core";
import { TidalArtistDetailView } from "../src/pages/library/ArtistDetail";

const mock = vi.hoisted(() => ({
  artist: vi.fn(),
  player: {
    play: vi.fn(),
    toggle: vi.fn(),
    toggleShuffle: vi.fn(),
    current: null as TrackListItem | null,
    isPlaying: false,
    shuffle: false,
  },
}));
vi.mock("../../core/src/api", async (original) => ({
  ...(await original<typeof import("../../core/src/api")>()),
  api: { getTidalArtist: mock.artist },
}));
vi.mock("../src/components/TrackList", () => ({ default: () => null }));
vi.mock("../src/context/Player", () => ({
  usePlayer: () => mock.player,
  useRemotePlayback: () => ({ targetDevice: null, commandPending: false }),
}));

const track = (id: string, unavailable?: boolean): TrackListItem => ({
  id,
  title: id,
  duration_ms: 1000,
  unavailable,
});

beforeEach(() => {
  mock.artist.mockReset();
  mock.player.play.mockReset();
  mock.player.toggle.mockReset();
  mock.player.current = null;
  mock.player.isPlaying = false;
  mock.player.shuffle = false;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function show(tracks: TrackListItem[]) {
  mock.artist.mockResolvedValueOnce({ albums: [], tracks });
  render(
    <TidalArtistDetailView id="123" name="Artist" onBack={() => {}} onOpenAlbum={() => {}} />,
  );
  await act(async () => {});
}

it("starts from the first available track and never queues unavailable ones", async () => {
  const tracks = [track("gone", true), track("a"), track("b")];
  await show(tracks);
  fireEvent.click(screen.getByRole("button", { name: "Play Artist" }));
  expect(mock.player.play).toHaveBeenCalledExactlyOnceWith(tracks[1], [tracks[1], tracks[2]]);
});

it("starts from a random available track when shuffle is on", async () => {
  mock.player.shuffle = true;
  vi.spyOn(Math, "random").mockReturnValue(0.75);
  const tracks = [track("a"), track("gone", true), track("b")];
  await show(tracks);
  fireEvent.click(screen.getByRole("button", { name: "Play Artist" }));
  expect(mock.player.play).toHaveBeenCalledExactlyOnceWith(tracks[2], [tracks[0], tracks[2]]);
});

it("pauses instead of restarting while one of the artist's tracks plays", async () => {
  const tracks = [track("a"), track("b")];
  mock.player.current = tracks[1];
  mock.player.isPlaying = true;
  await show(tracks);
  fireEvent.click(screen.getByRole("button", { name: "Pause Artist" }));
  expect(mock.player.toggle).toHaveBeenCalledOnce();
  expect(mock.player.play).not.toHaveBeenCalled();
});

it("disables play when none of the artist's tracks can be played", async () => {
  await show([track("gone", true)]);
  const button = screen.getByRole("button", { name: "Play Artist" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
});
