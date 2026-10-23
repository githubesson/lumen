import { afterEach, describe, expect, it, vi } from "vitest";
import type { GestureResponderEvent, View } from "react-native";
import {
  measureRect,
  offsetRect,
  screenOffsetOfPress,
} from "../components/playlist-picker/measure";

type Measure = (x: number, y: number, width: number, height: number) => void;

function view(rect: [number, number, number, number] | null): View {
  return {
    measureInWindow: (callback: Measure) => {
      if (rect) callback(...rect);
    },
  } as unknown as View;
}

function press(nativeEvent: Record<string, number>): GestureResponderEvent {
  return { nativeEvent } as unknown as GestureResponderEvent;
}

afterEach(() => vi.useRealTimers());

describe("screenOffsetOfPress", () => {
  it("finds where the sheet's layout sits on screen", async () => {
    // The row measures at y 210 in the sheet; the touch, 20 into the row, is
    // at 640 on screen, so the sheet's layout starts 410 down.
    const offset = await screenOffsetOfPress(
      view([0, 210, 393, 60]),
      press({ locationX: 100, locationY: 20, screenX: 108, screenY: 640 }),
    );
    expect(offset).toEqual({ x: 8, y: 410 });
    expect(offsetRect({ x: 24, y: 36, width: 48, height: 48 }, offset!)).toEqual({
      x: 32, y: 446, width: 48, height: 48,
    });
  });

  it("is zero when layout already measures from the window", async () => {
    const offset = await screenOffsetOfPress(
      view([0, 620, 393, 60]),
      press({ locationX: 100, locationY: 20, screenX: 100, screenY: 640 }),
    );
    expect(offset).toEqual({ x: 0, y: 0 });
  });

  it("gives up without the touch's screen point", async () => {
    expect(
      await screenOffsetOfPress(view([0, 0, 10, 10]), press({ locationX: 1, locationY: 1 })),
    ).toBeNull();
  });
});

describe("measureRect", () => {
  it("skips views that measure empty or not at all", async () => {
    vi.useFakeTimers();
    expect(await measureRect(null)).toBeNull();
    expect(await measureRect(view([0, 0, 0, 0]))).toBeNull();
    const stalled = measureRect(view(null));
    await vi.advanceTimersByTimeAsync(100);
    expect(await stalled).toBeNull();
  });
});
