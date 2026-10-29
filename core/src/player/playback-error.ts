import type { TrackListItem } from "../api";
import { displayText } from "../format";
import type { PlaybackError } from "./player-core";

/** One labelled line of a playback failure's details. */
export interface PlaybackErrorLine {
  label: string;
  value: string;
}

/**
 * A playback failure's details as labelled lines, in the order they're shown
 * and copied. `track` is the failed track, while it's still loaded.
 */
export function playbackErrorLines(
  error: PlaybackError,
  track: TrackListItem | null,
): PlaybackErrorLine[] {
  const { at, source, player, server } = error.details;
  const lines: PlaybackErrorLine[] = [{ label: "Error", value: error.message }];
  if (track?.id === error.trackId) {
    const artist = displayText(track.artist);
    const title = displayText(track.title, "Untitled");
    lines.push({ label: "Track", value: artist ? `${title} — ${artist}` : title });
  }
  lines.push(
    { label: "Track ID", value: error.trackId },
    { label: "Source", value: source },
    { label: "Player", value: player ?? "Gave no reason" },
    {
      label: "Server",
      value: server === undefined ? "Asking…" : (server ?? "Not asked: a downloaded copy"),
    },
    { label: "Time", value: new Date(at).toISOString() },
  );
  return lines;
}

/** The lines as plain text, to copy into a bug report. */
export function playbackErrorText(lines: PlaybackErrorLine[]): string {
  return lines.map(({ label, value }) => `${label}: ${value}`).join("\n");
}
