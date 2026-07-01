/**
 * Compact "2d 4h" / "3h 12m" / "45m" listening-time string for the Replay
 * hero and summary tiles.
 */
export function formatListeningTime(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes - days * 60 * 24) / 60);
  const minutes = totalMinutes - days * 60 * 24 - hours * 60;
  if (days >= 1) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours >= 1) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** Pluralized play count ("1 play" / "12 plays") for tile subtitles. */
export function playsLabel(plays: number): string {
  return `${plays} ${plays === 1 ? "play" : "plays"}`;
}
