import type { RepeatMode } from "@music-library/core";

/** SF Symbol for the repeat control in each mode. */
export function repeatModeIcon(repeat: RepeatMode): "repeat" | "repeat.1" {
  return repeat === "one" ? "repeat.1" : "repeat";
}

/** Spoken label: the current mode, then what tapping does next. */
export function repeatModeAccessibilityLabel(repeat: RepeatMode): string {
  switch (repeat) {
    case "off":
      return "Repeat off. Turn on repeat";
    case "all":
      return "Repeat all. Turn on repeat one";
    case "one":
      return "Repeat one. Turn repeat off";
  }
}
