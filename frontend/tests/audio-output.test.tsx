import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AudioOutputProvider, useAudioOutputDevices } from "../src/lib/audioOutput";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup(labels: string[]) {
  const media = Object.assign(new EventTarget(), {
    enumerateDevices: vi.fn().mockResolvedValue(
      labels.map((label, i) => ({ kind: "audiooutput", deviceId: `d${i}`, label })),
    ),
    getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
  });
  const original = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: media });
  Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true, value: vi.fn().mockResolvedValue(undefined) });
  const ref = createRef<HTMLAudioElement>();
  Object.defineProperty(ref, "current", { value: document.createElement("audio") });
  const restore = () => {
    if (original) Object.defineProperty(navigator, "mediaDevices", original);
    else Reflect.deleteProperty(navigator, "mediaDevices");
    Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
  };
  return { media, refs: [ref], restore };
}

function Devices({ active }: { active: boolean }) { useAudioOutputDevices(active); return null; }

it("opens the microphone only while the output row shows, never on startup or device changes", async () => {
  const { media, refs, restore } = setup(["", ""]);
  try {
    const { rerender } = render(<AudioOutputProvider audioRefs={refs}><Devices active={false} /></AudioOutputProvider>);
    await act(async () => {});
    expect(media.getUserMedia).not.toHaveBeenCalled();
    rerender(<AudioOutputProvider audioRefs={refs}><Devices active /></AudioOutputProvider>);
    await act(async () => {});
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    const listed = media.enumerateDevices.mock.calls.length;
    await act(async () => { media.dispatchEvent(new Event("devicechange")); });
    expect(media.enumerateDevices).toHaveBeenCalledTimes(listed + 1);
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    rerender(<AudioOutputProvider audioRefs={refs}><Devices active={false} /></AudioOutputProvider>);
    await act(async () => { media.dispatchEvent(new Event("devicechange")); });
    expect(media.enumerateDevices).toHaveBeenCalledTimes(listed + 1);
  } finally {
    cleanup();
    restore();
  }
});

it("skips the microphone when device names are already visible", async () => {
  const { media, refs, restore } = setup(["Speakers", "Headphones"]);
  try {
    render(<AudioOutputProvider audioRefs={refs}><Devices active /></AudioOutputProvider>);
    await act(async () => {});
    expect(media.enumerateDevices).toHaveBeenCalled();
    expect(media.getUserMedia).not.toHaveBeenCalled();
  } finally {
    cleanup();
    restore();
  }
});
