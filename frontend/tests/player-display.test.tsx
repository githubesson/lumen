import { render, renderHook, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { PlaybackDevice, PlayerState, TrackListItem } from "@music-library/core";
import NowPlaying from "../src/components/player/NowPlaying";
import { usePlayerDisplay } from "../src/components/player/usePlayerDisplay";

const mock = vi.hoisted(() => ({
  player: null as unknown as PlayerState & { seek: () => void },
  remote: { targetDevice: null as PlaybackDevice | null, commandPending: false },
}));
vi.mock("react-router-dom", () => ({ useLocation: () => ({ pathname: "/" }) }));
vi.mock("../src/lib/fh6", () => ({ fh6Transport: vi.fn(), useFH6Snapshot: () => null }));
vi.mock("../src/context/Player", () => ({
  usePlayer: () => mock.player,
  useRemotePlayback: () => mock.remote,
}));

const track: TrackListItem = {
  id: "t1",
  title: "Song",
  artist: "Artist",
  album_title: "Album",
  duration_ms: 1000,
};
const desktop: PlaybackDevice = {
  deviceId: "desktop",
  deviceName: "Desktop",
  online: true,
  controlEnabled: true,
  capabilities: [],
  connectedAt: "",
  activity: null,
};

beforeEach(() => {
  mock.player = {
    current: track,
    queue: [track],
    index: 0,
    isPlaying: true,
    volume: 0.3,
    muted: true,
    shuffle: true,
    repeat: "one",
    playbackError: null,
    seek: vi.fn(),
  };
  mock.remote = { targetDevice: desktop, commandPending: false };
});

it("shows the provider's displayed state while controlling another device", () => {
  const { result } = renderHook(() => usePlayerDisplay());
  expect(result.current).toMatchObject({
    isRemoteMode: true,
    displayCurrent: track,
    displayHasTrack: true,
    displayPlaying: true,
    displayTitle: "Song",
    displayArtist: "Artist · Album",
    shownVolume: 0.3,
    shownMuted: true,
    shownShuffle: true,
    shownRepeat: "one",
  });
});

it("names the device when nothing plays there", () => {
  mock.player = { ...mock.player, current: null, queue: [], isPlaying: false };
  const { result } = renderHook(() => usePlayerDisplay());
  expect(result.current.displayTitle).toBe("Nothing playing on Desktop");
  expect(result.current.displayArtist).toBe("Desktop");
  expect(result.current.transportDisabled).toBe(true);
});

it("keeps transport enabled while a remote command is pending", () => {
  mock.remote = { targetDevice: desktop, commandPending: true };
  const { result } = renderHook(() => usePlayerDisplay());
  expect(result.current.transportDisabled).toBe(false);
});

it("shows the current track's playback error in place of its artist", () => {
  const message = "TIDAL refused to stream this track: Not available in your region";
  mock.remote = { targetDevice: null, commandPending: false };
  mock.player = { ...mock.player, isPlaying: false, playbackError: { trackId: "t1", message } };
  const { result, rerender } = renderHook(() => usePlayerDisplay());
  expect(result.current.displayError).toBe(message);
  expect(result.current.displayArtist).toBe("Artist · Album");

  mock.player = { ...mock.player, playbackError: { trackId: "t0", message } };
  rerender();
  expect(result.current.displayError).toBeNull();
});

it("renders the error as the artist line and announces it", () => {
  const message = "TIDAL only has a preview of this track.";
  const { container, rerender } = render(
    <NowPlaying track={track} title="Song" artist="Artist · Album" isFH6Mode={false} />,
  );
  const line = container.querySelector(".np-artist")!;
  expect(line.textContent).toBe("Artist · Album");
  expect(screen.getByRole("status").textContent).toBe("");

  rerender(
    <NowPlaying track={track} title="Song" artist="Artist · Album" error={message} isFH6Mode={false} />,
  );
  expect(line.textContent).toBe(message);
  expect(line.getAttribute("title")).toBe(message);
  expect(line.classList.contains("np-error")).toBe(true);
  expect(screen.getByRole("status").textContent).toBe(message);
});
