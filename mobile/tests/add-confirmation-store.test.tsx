import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  finishAddConfirmation,
  showAddConfirmation,
  useAddConfirmation,
  type AddConfirmationRequest,
  type AddConfirmationResult,
} from "../components/add-confirmation/store";

const native = vi.hoisted(() => ({
  alert: vi.fn(),
  announce: vi.fn(),
}));
vi.mock("react-native", () => ({
  Alert: { alert: native.alert },
  AccessibilityInfo: { announceForAccessibility: native.announce },
}));

function Probe() {
  const confirmation = useAddConfirmation();
  return <span>{confirmation ? `${confirmation.id}:${confirmation.playlistName}` : "none"}</span>;
}
const shown = () => renderToStaticMarkup(<Probe />).replace(/<\/?span>/g, "");

function request(
  done: Promise<AddConfirmationResult>,
  extra: Partial<AddConfirmationRequest> = {},
): AddConfirmationRequest {
  return {
    from: null,
    trackArt: { uri: null, placeholder: null },
    playlistName: "gym",
    playlistArt: null,
    playlistGlyph: "music.note.list",
    created: false,
    done,
    ...extra,
  };
}

function currentId() {
  return Number(shown().split(":")[0]);
}

beforeEach(() => {
  vi.useFakeTimers();
  native.alert.mockClear();
  native.announce.mockClear();
});
afterEach(() => {
  finishAddConfirmation(currentId());
  vi.useRealTimers();
});

describe("add confirmation store", () => {
  it("shows the newest confirmation until the HUD finishes it", () => {
    showAddConfirmation(request(new Promise(() => {})));
    const first = currentId();
    showAddConfirmation(request(new Promise(() => {}), { playlistName: "rage" }));
    expect(shown()).toBe(`${first + 1}:rage`);
    // The replaced HUD finishing doesn't take the new one down.
    finishAddConfirmation(first);
    expect(shown()).toBe(`${first + 1}:rage`);
    finishAddConfirmation(first + 1);
    expect(shown()).toBe("none");
  });

  it("alerts a failure once the picker sheet has closed", async () => {
    showAddConfirmation(
      request(Promise.resolve({ ok: false, title: "Couldn't add track", message: "Offline." })),
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(native.alert).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(native.alert).toHaveBeenCalledWith("Couldn't add track", "Offline.");
    expect(native.announce).not.toHaveBeenCalled();
  });

  it("alerts a late failure without waiting again", async () => {
    let settle: (result: AddConfirmationResult) => void = () => {};
    showAddConfirmation(request(new Promise((resolve) => (settle = resolve))));
    await vi.advanceTimersByTimeAsync(2000);
    settle({ ok: false, title: "Couldn't add track", message: "Timed out." });
    await vi.advanceTimersByTimeAsync(0);
    expect(native.alert).toHaveBeenCalledWith("Couldn't add track", "Timed out.");
  });

  it("turns a rejected add into the usual alert", async () => {
    showAddConfirmation(request(Promise.reject(new Error("boom"))));
    await vi.advanceTimersByTimeAsync(700);
    expect(native.alert).toHaveBeenCalledWith("Couldn't add track", "Please try again.");
  });

  it("tells VoiceOver where the track went", async () => {
    showAddConfirmation(request(Promise.resolve({ ok: true })));
    await vi.advanceTimersByTimeAsync(700);
    expect(native.announce).toHaveBeenCalledWith("Added to gym");
    showAddConfirmation(
      request(Promise.resolve({ ok: true }), { playlistName: "night drive", created: true }),
    );
    await vi.advanceTimersByTimeAsync(700);
    expect(native.announce).toHaveBeenLastCalledWith("Added to new playlist night drive");
    expect(native.alert).not.toHaveBeenCalled();
  });
});
