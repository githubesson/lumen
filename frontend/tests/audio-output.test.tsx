import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AudioOutputProvider, useAudioOutputDevices } from "../src/lib/audioOutput";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("opens the microphone only while Settings opens, never on startup or device changes", async () => {
  const media = Object.assign(new EventTarget(), {
    enumerateDevices: vi.fn().mockResolvedValue([]),
    getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
  });
  const original = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: media });
  Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true, value: vi.fn().mockResolvedValue(undefined) });
  const ref = createRef<HTMLAudioElement>();
  Object.defineProperty(ref, "current", { value: document.createElement("audio") });
  const refs = [ref];
  function Devices({ open }: { open: boolean }) { useAudioOutputDevices(open); return null; }
  const { rerender } = render(<AudioOutputProvider audioRefs={refs}><Devices open={false} /></AudioOutputProvider>);
  await act(async () => {});
  expect(media.getUserMedia).not.toHaveBeenCalled();
  rerender(<AudioOutputProvider audioRefs={refs}><Devices open /></AudioOutputProvider>);
  await act(async () => {});
  expect(media.getUserMedia).toHaveBeenCalledTimes(1);
  await act(async () => { media.dispatchEvent(new Event("devicechange")); });
  expect(media.enumerateDevices).toHaveBeenCalledTimes(2);
  expect(media.getUserMedia).toHaveBeenCalledTimes(1);
  rerender(<AudioOutputProvider audioRefs={refs}><Devices open={false} /></AudioOutputProvider>);
  await act(async () => { media.dispatchEvent(new Event("devicechange")); });
  expect(media.enumerateDevices).toHaveBeenCalledTimes(2);
  if (original) Object.defineProperty(navigator, "mediaDevices", original);
  else Reflect.deleteProperty(navigator, "mediaDevices");
  Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
});
