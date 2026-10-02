import { AppState } from "react-native";
import type { ResumeSubscriber } from "@music-library/core";

/**
 * Calls `onResume` each time the app returns to the foreground. For core's
 * `useLocalDay`: a suspended app's timers stall, so the date is rechecked
 * on the way back.
 */
export const subscribeAppActive: ResumeSubscriber = (onResume) => {
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") onResume();
  });
  return () => subscription.remove();
};
