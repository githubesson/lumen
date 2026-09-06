/** Translucent accent fill shared by the crop window and waveform selection. */
export function selectionTint(scheme: "light" | "dark") {
  return scheme === "dark"
    ? "rgba(10, 132, 255, 0.18)"
    : "rgba(10, 132, 255, 0.12)";
}
