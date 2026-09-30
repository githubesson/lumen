import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import SeekBar from "../src/components/player/SeekBar";

afterEach(cleanup);
function pointer(target: Element | Window, type: string, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(target, event);
}
it("previews dragging and seeks once on release; cancel does not seek", () => {
  const seek = vi.fn();
  render(<SeekBar label="Position" value={0.1} onSeek={seek} />);
  const slider = screen.getByRole("slider");
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 100 } as DOMRect);
  pointer(slider, "pointerdown", 20);
  pointer(window, "pointermove", 70);
  expect(seek).not.toHaveBeenCalled();
  expect(slider.getAttribute("aria-valuenow")).toBe("70");
  pointer(window, "pointerup", 75);
  expect(seek).toHaveBeenCalledExactlyOnceWith(0.75);
  pointer(slider, "pointerdown", 50);
  pointer(window, "pointercancel", 50);
  expect(seek).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(slider, { key: "End" });
  expect(seek).toHaveBeenLastCalledWith(1);
});
it("keeps live volume adjustment available", () => {
  const seek = vi.fn();
  render(<SeekBar label="Volume" value={0.1} onSeek={seek} commitOnRelease={false} />);
  const slider = screen.getByRole("slider");
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 100 } as DOMRect);
  pointer(slider, "pointerdown", 20);
  pointer(window, "pointermove", 70);
  expect(seek).toHaveBeenLastCalledWith(0.7);
});
it("drops the preview without seeking when the drag is lost (window blur or lost capture)", () => {
  const seek = vi.fn();
  render(<SeekBar label="Position" value={0.1} onSeek={seek} />);
  const slider = screen.getByRole("slider");
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 100 } as DOMRect);
  pointer(slider, "pointerdown", 20);
  pointer(window, "pointermove", 70);
  fireEvent.blur(window);
  expect(slider.getAttribute("aria-valuenow")).toBe("10");
  pointer(slider, "pointerdown", 20);
  pointer(window, "pointermove", 60);
  pointer(slider, "lostpointercapture", 60);
  expect(slider.getAttribute("aria-valuenow")).toBe("10");
  pointer(window, "pointerup", 60);
  expect(seek).not.toHaveBeenCalled();
});
