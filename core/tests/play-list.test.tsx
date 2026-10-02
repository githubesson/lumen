// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TrackListItem } from "../src/api";
import {
  listPlaybackState,
  startListPlayback,
  usePlayFromList,
} from "../src/player/play-list";

const t = (id: string, unavailable?: boolean): TrackListItem => ({
  id,
  title: id,
  duration_ms: 1000,
  unavailable,
});

describe("usePlayFromList", () => {
  it("plays the pressed track with the list's playable tracks as the queue", () => {
    const play = vi.fn();
    const tracks = [t("a"), t("b", true), t("c")];
    const { result } = renderHook(() => usePlayFromList(play, tracks));
    act(() => result.current.playTrack(tracks[2]));
    expect(play).toHaveBeenCalledExactlyOnceWith(tracks[2], [tracks[0], tracks[2]]);
    expect(result.current.getQueue()).toEqual([tracks[0], tracks[2]]);
  });

  it("ignores presses on unavailable tracks", () => {
    const play = vi.fn();
    const tracks = [t("a"), t("b", true)];
    const { result } = renderHook(() => usePlayFromList(play, tracks));
    act(() => result.current.playTrack(tracks[1]));
    expect(play).not.toHaveBeenCalled();
  });

  it("keeps its identity across list refreshes and reads the latest list", () => {
    const play = vi.fn();
    const { result, rerender } = renderHook(
      ({ tracks }: { tracks: TrackListItem[] }) => usePlayFromList(play, tracks),
      { initialProps: { tracks: [t("a")] } },
    );
    const first = result.current;
    const refreshed = [t("a"), t("b")];
    rerender({ tracks: refreshed });
    expect(result.current).toBe(first);
    act(() => result.current.playTrack(refreshed[1]));
    expect(play).toHaveBeenCalledWith(refreshed[1], refreshed);
  });
});

describe("listPlaybackState", () => {
  const tracks = [t("a"), t("b")];

  it("shows pause only while one of the list's tracks is playing", () => {
    expect(listPlaybackState(tracks, { id: "b" }, true)).toEqual({
      playingHere: true,
      showPause: true,
      canPlay: true,
    });
    expect(listPlaybackState(tracks, { id: "b" }, false).showPause).toBe(false);
    expect(listPlaybackState(tracks, { id: "z" }, true)).toMatchObject({
      playingHere: false,
      showPause: false,
    });
    expect(listPlaybackState(tracks, null, true).playingHere).toBe(false);
  });

  it("can't play a list with nothing playable in it", () => {
    expect(listPlaybackState([], null, false).canPlay).toBe(false);
    expect(listPlaybackState([t("a", true)], null, false).canPlay).toBe(false);
  });
});

describe("startListPlayback", () => {
  it("starts at the first playable track, queueing only playable ones", () => {
    const play = vi.fn();
    const tracks = [t("a", true), t("b"), t("c")];
    expect(startListPlayback(play, tracks, false)).toBe(true);
    expect(play).toHaveBeenCalledExactlyOnceWith(tracks[1], [tracks[1], tracks[2]]);
  });

  it("starts at a random playable track when shuffle is on", () => {
    const play = vi.fn();
    const tracks = [t("a"), t("b", true), t("c"), t("d")];
    startListPlayback(play, tracks, true, () => 0.5);
    expect(play).toHaveBeenLastCalledWith(tracks[2], [tracks[0], tracks[2], tracks[3]]);
    startListPlayback(play, tracks, true, () => 0.99);
    expect(play).toHaveBeenLastCalledWith(tracks[3], expect.any(Array));
    startListPlayback(play, tracks, true, () => 1);
    expect(play).toHaveBeenLastCalledWith(tracks[3], expect.any(Array));
  });

  it("does nothing for a list with nothing playable, and reports a refused start", () => {
    const play = vi.fn();
    expect(startListPlayback(play, [t("a", true)], false)).toBe(false);
    expect(play).not.toHaveBeenCalled();
    expect(startListPlayback(() => false, [t("a")], false)).toBe(false);
  });
});
