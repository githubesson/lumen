import { describe, expect, it } from "vitest";
import type { PlaybackActivity, TrackListItem } from "../src/api";
import type { RemotePlaybackCommandResult } from "../src/player/activity-sync";
import {
  buildRemoteQueue,
  playbackDeviceButtonLabel,
  playbackDeviceKind,
  playbackDeviceStatus,
  remoteCommandError,
} from "../src/player/remote-control";

const result = (over: Partial<RemotePlaybackCommandResult>): RemotePlaybackCommandResult => ({
  commandId: "c",
  sourceDeviceId: "a",
  targetDeviceId: "b",
  status: "applied",
  ...over,
});
const activity = (over: Partial<PlaybackActivity>): PlaybackActivity => ({
  device_id: "b",
  device_name: "Desktop",
  track_id: "t1",
  title: "One",
  position_sec: 0,
  is_playing: true,
  updated_at: "",
  ...over,
});

describe("remoteCommandError", () => {
  it("is null for no result or an applied one", () => {
    expect(remoteCommandError(null)).toBeNull();
    expect(remoteCommandError(result({}))).toBeNull();
  });

  it("prefers the reported error and falls back to the status", () => {
    expect(remoteCommandError(result({ status: "rejected", error: "nothing is loaded" }))).toBe(
      "nothing is loaded",
    );
    expect(remoteCommandError(result({ status: "timeout" }))).toBe("Command timeout");
    expect(remoteCommandError(result({ status: "disconnected", error: "" }))).toBe(
      "Command disconnected",
    );
  });
});

describe("playbackDeviceButtonLabel", () => {
  it("names the controlled device, or invites choosing one", () => {
    expect(playbackDeviceButtonLabel({ deviceName: "Desktop" })).toBe("Playback device: Desktop");
    expect(playbackDeviceButtonLabel(null)).toBe("Choose playback device");
  });
});

describe("playbackDeviceStatus", () => {
  it("says what a device is playing or paused on", () => {
    expect(playbackDeviceStatus({ activity: activity({}) })).toEqual({
      label: "Playing · One",
      playing: true,
    });
    expect(playbackDeviceStatus({ activity: activity({ is_playing: false }) })).toEqual({
      label: "Paused · One",
      playing: false,
    });
  });

  it("treats a title-less heartbeat like no activity rather than 'Playing · '", () => {
    for (const device of [
      { activity: null },
      { activity: activity({ title: "" }) },
      { activity: activity({ title: "  " }) },
    ]) {
      expect(playbackDeviceStatus(device)).toEqual({
        label: "Online · Nothing playing",
        playing: false,
      });
    }
  });
});

describe("playbackDeviceKind", () => {
  it("maps the names each app publishes", () => {
    expect(playbackDeviceKind("iPad")).toBe("tablet");
    expect(playbackDeviceKind("iPhone")).toBe("phone");
    expect(playbackDeviceKind("Mobile")).toBe("phone");
    expect(playbackDeviceKind("Web")).toBe("web");
    expect(playbackDeviceKind("Desktop")).toBe("desktop");
    expect(playbackDeviceKind("Living room")).toBe("desktop");
  });
});

describe("buildRemoteQueue", () => {
  const t = (id: string, unavailable?: boolean): TrackListItem => ({
    id,
    title: id,
    duration_ms: 1000,
    unavailable,
  });

  it("leaves unavailable tracks out of the window", () => {
    const queue = [t("a"), t("b", true), t("c"), t("d", true)];
    expect(buildRemoteQueue(t("c"), queue).map((track) => track.id)).toEqual(["a", "c"]);
  });

  it("spends the 50-track window on playable tracks", () => {
    const queue = Array.from({ length: 120 }, (_, i) => t(String(i), i % 2 === 1));
    const window = buildRemoteQueue(queue[100], queue);
    expect(window).toHaveLength(50);
    expect(window.every((track) => !track.unavailable)).toBe(true);
    expect(window.some((track) => track.id === "100")).toBe(true);
  });
});
