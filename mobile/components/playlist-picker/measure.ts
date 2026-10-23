import type { GestureResponderEvent, View } from "react-native";
import type { WindowRect } from "../add-confirmation/store";

const MEASURE_TIMEOUT_MS = 100;

/** `view`'s rect as layout measures it, or null if that fails or stalls. */
export function measureRect(view: View | null): Promise<WindowRect | null> {
  return new Promise((resolve) => {
    if (!view) {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => resolve(null), MEASURE_TIMEOUT_MS);
    view.measureInWindow((x, y, width, height) => {
      clearTimeout(timer);
      resolve(width > 0 && height > 0 ? { x, y, width, height } : null);
    });
  });
}

/**
 * How far layout coordinates sit from the screen's. Inside a sheet, views
 * measure from the sheet's corner, not the window's; a press on `view`
 * carries the touch both on screen and within the view, which pins the
 * view's corner on screen. Zero when layout already measures from the window.
 */
export async function screenOffsetOfPress(
  view: View | null,
  event: GestureResponderEvent,
): Promise<{ x: number; y: number } | null> {
  // Read before awaiting: the event is only guaranteed during the handler.
  const { locationX, locationY, screenX, screenY } =
    event.nativeEvent as GestureResponderEvent["nativeEvent"] & {
      screenX?: number;
      screenY?: number;
    };
  if (typeof screenX !== "number" || typeof screenY !== "number") return null;
  const rect = await measureRect(view);
  if (!rect) return null;
  return { x: screenX - locationX - rect.x, y: screenY - locationY - rect.y };
}

/** `rect` moved by `offset`. */
export function offsetRect(
  rect: WindowRect,
  offset: { x: number; y: number },
): WindowRect {
  return { ...rect, x: rect.x + offset.x, y: rect.y + offset.y };
}
