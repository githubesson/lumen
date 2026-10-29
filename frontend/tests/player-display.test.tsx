import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlaybackDevice, PlayerState, TrackListItem } from "@music-library/core";
import MiniPlayerPanel from "../src/components/player/MiniPlayerPanel";
import NowPlaying from "../src/components/player/NowPlaying";
import { PlaybackErrorDetails } from "../src/components/player/PlaybackErrorPopover";
import { usePlayerDisplay } from "../src/components/player/usePlayerDisplay";

const mock = vi.hoisted(() => ({
  player: null as unknown as PlayerState,
  remote: { targetDevice: null as PlaybackDevice | null, commandPending: false },
}));
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
  };
  mock.remote = { targetDevice: desktop, commandPending: false };
});
afterEach(cleanup);

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

const details = {
  at: Date.UTC(2026, 9, 29, 12, 0, 0),
  source: "/api/tracks/t1/stream",
  player: "MEDIA_ERR_SRC_NOT_SUPPORTED: DEMUXER_ERROR_COULD_NOT_OPEN",
  server: "HTTP 200 · audio/flac",
};

it("shows the current track's playback error in place of its artist", () => {
  const message = "TIDAL refused to stream this track: Not available in your region";
  mock.remote = { targetDevice: null, commandPending: false };
  mock.player = { ...mock.player, isPlaying: false, playbackError: { trackId: "t1", message, details } };
  const { result, rerender } = renderHook(() => usePlayerDisplay());
  expect(result.current.displayError).toBe(message);
  expect(result.current.displayArtist).toBe("Artist · Album");

  mock.player = { ...mock.player, playbackError: { trackId: "t0", message, details } };
  rerender();
  expect(result.current.displayError).toBeNull();
});

it("renders the error as the artist line and announces it", () => {
  const message = "TIDAL only has a preview of this track.";
  const { container, rerender } = render(
    <NowPlaying track={track} title="Song" artist="Artist · Album" />,
  );
  const line = container.querySelector(".np-artist")!;
  expect(line.textContent).toBe("Artist · Album");
  expect(screen.getByRole("status").textContent).toBe("");

  rerender(
    <NowPlaying track={track} title="Song" artist="Artist · Album" error={message} />,
  );
  expect(line.textContent).toBe(message);
  expect(screen.getByRole("button", { name: message }).getAttribute("title")).toBe(message);
  expect(line.classList.contains("np-error")).toBe(true);
  expect(screen.getByRole("status").textContent).toBe(message);
});

it("shows what happened when the error is clicked, and copies it", async () => {
  const message = "Couldn't play this track.";
  mock.player = { ...mock.player, current: track, playbackError: { trackId: "t1", message, details } };
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<NowPlaying track={track} title="Song" artist="Artist · Album" error={message} />);

  const line = screen.getByRole("button", { name: message });
  expect(line.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(line);
  expect(line.getAttribute("aria-expanded")).toBe("true");
  const dialog = await screen.findByRole("dialog", { name: "Playback error" });
  expect(dialog.textContent).toContain("DEMUXER_ERROR_COULD_NOT_OPEN");
  expect(dialog.textContent).toContain("HTTP 200 · audio/flac");

  fireEvent.click(within(dialog).getByRole("button", { name: "Copy details" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  expect(writeText.mock.calls[0]).toEqual([
    [
      "Error: Couldn't play this track.",
      "Track: Song — Artist",
      "Track ID: t1",
      "Source: /api/tracks/t1/stream",
      "Player: MEDIA_ERR_SRC_NOT_SUPPORTED: DEMUXER_ERROR_COULD_NOT_OPEN",
      "Server: HTTP 200 · audio/flac",
      "Time: 2026-10-29T12:00:00.000Z",
    ].join("\n"),
  ]);
  expect(await within(dialog).findByRole("button", { name: "Copied" })).toBeTruthy();
});

it("closes the details on Escape or a click outside", async () => {
  const message = "Couldn't play this track.";
  mock.player = { ...mock.player, current: track, playbackError: { trackId: "t1", message, details } };
  render(<NowPlaying track={track} title="Song" artist="Artist · Album" error={message} />);
  const line = screen.getByRole("button", { name: message });

  fireEvent.click(line);
  await screen.findByRole("dialog", { name: "Playback error" });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(line.getAttribute("aria-expanded")).toBe("false");

  fireEvent.click(line);
  expect(line.getAttribute("aria-expanded")).toBe("true");
  fireEvent.mouseDown(document.body);
  expect(line.getAttribute("aria-expanded")).toBe("false");
});

it("shuts the details when the failure clears, and doesn't reopen them for the next", async () => {
  const message = "Couldn't play this track.";
  mock.player = { ...mock.player, current: track, playbackError: { trackId: "t1", message, details } };
  const { rerender } = render(
    <NowPlaying track={track} title="Song" artist="Artist · Album" error={message} />,
  );
  fireEvent.click(screen.getByRole("button", { name: message }));
  await screen.findByRole("dialog", { name: "Playback error" });

  // Played again: the failure is gone, and so are its details.
  mock.player = { ...mock.player, playbackError: null };
  rerender(<NowPlaying track={track} title="Song" artist="Artist · Album" error={null} />);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  mock.player = { ...mock.player, playbackError: { trackId: "t1", message, details: { ...details } } };
  rerender(<NowPlaying track={track} title="Song" artist="Artist · Album" error={message} />);
  expect(screen.getByRole("button", { name: message }).getAttribute("aria-expanded")).toBe("false");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps the failed track in the details while they close over the next one", () => {
  const message = "Couldn't play this track.";
  const next: TrackListItem = { ...track, id: "t2", title: "Next song" };
  mock.player = { ...mock.player, current: track, playbackError: { trackId: "t1", message, details } };
  const { container, rerender } = render(<PlaybackErrorDetails />);
  expect(container.textContent).toContain("Song — Artist");

  mock.player = { ...mock.player, current: next, playbackError: null };
  rerender(<PlaybackErrorDetails />);
  expect(container.textContent).toContain("Song — Artist");
  expect(container.textContent).toContain(message);
});

it("keeps the closing details on the failure they opened for", () => {
  const first = { trackId: "t1", message: "Couldn't play this track.", details };
  const second = { trackId: "t2", message: "Couldn't play this track.", details: { ...details, server: "HTTP 404 · not found" } };
  mock.player = { ...mock.player, current: track, playbackError: first };
  const { container, rerender } = render(<PlaybackErrorDetails />);

  // The next track failed while the popover fades out.
  mock.player = { ...mock.player, current: { ...track, id: "t2" }, playbackError: second };
  rerender(<PlaybackErrorDetails frozen />);
  expect(container.textContent).toContain("HTTP 200 · audio/flac");
  expect(container.textContent).not.toContain("HTTP 404");
});

it.each(["its button", "Escape"])("sends focus back to the error line when closed with %s", async (how) => {
  const message = "Couldn't play this track.";
  mock.player = { ...mock.player, current: track, playbackError: { trackId: "t1", message, details } };
  render(<NowPlaying track={track} title="Song" artist="Artist · Album" error={message} />);
  const line = screen.getByRole("button", { name: message });
  fireEvent.click(line);
  const dialog = await screen.findByRole("dialog", { name: "Playback error" });
  const copy = within(dialog).getByRole("button", { name: "Copy details" });
  copy.focus();

  if (how === "Escape") fireEvent.keyDown(copy, { key: "Escape" });
  else fireEvent.click(within(dialog).getByRole("button", { name: "Close playback error" }));
  expect(line.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(line);
});

it("leaves focus alone when the details close from outside", async () => {
  const message = "Couldn't play this track.";
  mock.player = { ...mock.player, current: track, playbackError: { trackId: "t1", message, details } };
  render(
    <>
      <input aria-label="Search" />
      <NowPlaying track={track} title="Song" artist="Artist · Album" error={message} />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: message }));
  await screen.findByRole("dialog", { name: "Playback error" });
  const search = screen.getByRole("textbox", { name: "Search" });
  search.focus();

  fireEvent.keyDown(search, { key: "Escape" });
  expect(document.activeElement).toBe(search);
});

it("shows the details in the mini player's error panel", () => {
  const message = "Couldn't play this track.";
  mock.remote = { targetDevice: null, commandPending: false };
  mock.player = { ...mock.player, current: track, playbackError: { trackId: "t1", message, details } };
  render(<MiniPlayerPanel panel="error" />);
  expect(screen.getByText("Playback error", { selector: ".mini-panel-title" })).toBeTruthy();
  const region = screen.getByRole("region", { name: "Playback error" });
  expect(region.textContent).toContain("HTTP 200 · audio/flac");
  expect(within(region).getByRole("button", { name: "Copy details" })).toBeTruthy();
});

it("opens the mini player's panel instead of a popover", () => {
  const message = "Couldn't play this track.";
  const onToggle = vi.fn();
  render(
    <NowPlaying
      track={track}
      title="Song"
      artist="Artist · Album"
      error={message}
      errorPanel={{ open: false, controls: "mini-player-panel", onToggle, close: vi.fn() }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: message }));
  expect(onToggle).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("shuts the mini player's error panel when the failure clears", () => {
  const message = "Couldn't play this track.";
  const close = vi.fn();
  const panel = (open: boolean) => ({ open, controls: "mini-player-panel", onToggle: vi.fn(), close });
  const { rerender } = render(
    <NowPlaying track={track} title="Song" artist="Artist · Album" error={message} errorPanel={panel(true)} />,
  );
  expect(close).not.toHaveBeenCalled();

  // Another panel is up: nothing to shut.
  rerender(<NowPlaying track={track} title="Song" artist="Artist · Album" error={null} errorPanel={panel(false)} />);
  expect(close).not.toHaveBeenCalled();

  rerender(<NowPlaying track={track} title="Song" artist="Artist · Album" error={message} errorPanel={panel(true)} />);
  rerender(<NowPlaying track={track} title="Song" artist="Artist · Album" error={null} errorPanel={panel(true)} />);
  expect(close).toHaveBeenCalled();
});
