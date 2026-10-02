import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ArtistDetailView } from "../src/pages/library/ArtistDetail";

const mock = vi.hoisted(() => ({ getArtist: vi.fn(), listArtistTracks: vi.fn() }));
vi.mock("../../core/src/api", async (original) => ({
  ...(await original<typeof import("../../core/src/api")>()),
  api: { getArtist: mock.getArtist, listArtistTracks: mock.listArtistTracks },
}));
vi.mock("../src/components/TrackList", () => ({ default: () => null }));
vi.mock("../src/context/Player", () => ({
  usePlayer: () => ({ play: vi.fn(), toggle: vi.fn(), toggleShuffle: vi.fn(), current: null, isPlaying: false, shuffle: false }),
  useRemotePlayback: () => ({ targetDevice: null, commandPending: false }),
}));

afterEach(cleanup);

it("shows a failed load with a way back instead of loading forever", async () => {
  mock.getArtist.mockRejectedValueOnce(new Error("upstream"));
  mock.listArtistTracks.mockResolvedValueOnce([]);
  const onBack = vi.fn();
  render(<ArtistDetailView id="artist-1" onBack={onBack} onOpenAlbum={() => {}} />);
  await act(async () => {});
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.queryByText("Loading library…")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to library" }));
  expect(onBack).toHaveBeenCalledOnce();
});
