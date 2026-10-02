import type { RepeatMode } from "@music-library/core";

/** SF Symbol for the repeat control in each mode. */
export function repeatModeIcon(repeat: RepeatMode): "repeat" | "repeat.1" {
  return repeat === "one" ? "repeat.1" : "repeat";
}
