// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { PlaybackDevice, PlaybackRemoteSessionSnapshot } from "../src/player/activity-sync";
import { useRemotePlaybackTarget } from "../src/player/remote-control";

const device: PlaybackDevice = {
  deviceId: "desktop", deviceName: "Desktop", online: true,
  controlEnabled: true, capabilities: [], connectedAt: "", activity: null,
};
const session: PlaybackRemoteSessionSnapshot = {
  deviceId: "local", connected: true, devicesReady: true, devices: [device],
};
afterEach(cleanup);

function setup() {
  const hook = renderHook(useRemotePlaybackTarget, { initialProps: session });
  act(() => hook.result.current.setTargetDeviceId(device.deviceId));
  expect(hook.result.current.targetDevice).toEqual(device);
  return hook;
}

it("returns to local controls when the target disappears and stays local when it returns", () => {
  const { result, rerender } = setup();
  rerender({ ...session, devices: [] });
  expect(result.current.targetDeviceId).toBeNull();
  expect(result.current.targetDevice).toBeNull();
  rerender(session);
  expect(result.current.targetDeviceId).toBeNull();
});

it("keeps selection while disconnected and awaiting presence, then clears a missing target", () => {
  const { result, rerender } = setup();
  rerender({ ...session, connected: false, devicesReady: false, devices: [] });
  expect(result.current.targetDevice).toEqual(device);
  rerender({ ...session, devicesReady: false, devices: [] });
  expect(result.current.targetDeviceId).toBe(device.deviceId);
  rerender({ ...session, devices: [] });
  expect(result.current.targetDevice).toBeNull();
});

it("refreshes the selected snapshot and preserves it across a temporary disconnect", () => {
  const { result, rerender } = setup();
  const updated = { ...device, deviceName: "Updated desktop" };
  rerender({ ...session, devices: [updated] });
  expect(result.current.targetDevice).toEqual(updated);
  rerender({ ...session, connected: false, devicesReady: false, devices: [] });
  expect(result.current.targetDevice).toEqual(updated);
  rerender(session);
  expect(result.current.targetDevice).toEqual(device);
});

it.each([{ online: false }, { controlEnabled: false }])("clears a target that is no longer controllable: %j", (patch) => {
  const { result, rerender } = setup();
  rerender({ ...session, devices: [{ ...device, ...patch }] });
  expect(result.current.targetDeviceId).toBeNull();
});

it("ignores unrelated device departures and permits manually returning to local", () => {
  const { result, rerender } = setup();
  rerender({ ...session, devices: [device, { ...device, deviceId: "other" }] });
  rerender(session);
  expect(result.current.targetDeviceId).toBe(device.deviceId);
  act(() => result.current.setTargetDeviceId(null));
  expect(result.current.targetDevice).toBeNull();
});
