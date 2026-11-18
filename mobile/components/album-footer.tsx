import { Text, View } from "react-native";
import { formatCalendarDate, formatTotalMs, metaLine, pluralize } from "@music-library/core";
import { useTheme } from "../theme/theme";

/**
 * Under an album's songs: when it came out (the full date when the release
 * gives one, else the year), how many tracks and how long ("13 tracks ·
 * 43 min"), and its copyright line.
 */
export function AlbumFooter({
  releaseDate,
  releaseYear,
  trackCount,
  durationMs,
  copyright,
  inset = 0,
}: {
  releaseDate?: string;
  releaseYear?: number;
  /**
   * The album's own totals, as its header shows them, rather than the rows
   * that happened to load (a failed track request, a partial TIDAL list).
   */
  trackCount: number;
  durationMs: number;
  copyright?: string;
  /** The centred cover's inset on an iPad (`useAlbumCoverInset`). */
  inset?: number;
}) {
  const theme = useTheme();
  const date = formatCalendarDate(releaseDate, undefined, "long");
  const released = date !== "—" ? date : releaseYear ? String(releaseYear) : null;
  const length = metaLine([
    pluralize(trackCount, "track"),
    durationMs > 0 ? formatTotalMs(Math.max(durationMs, 60_000)) : "",
  ]);
  const note = { color: theme.color.fgMuted, fontSize: 13, lineHeight: 18 } as const;
  return (
    <View
      style={{
        paddingHorizontal: inset + theme.space.lg,
        paddingTop: theme.space.xl,
        gap: 2,
      }}
    >
      {released ? (
        <Text style={{ color: theme.color.fgSubtle, fontSize: 14, lineHeight: 19 }}>
          {released}
        </Text>
      ) : null}
      <Text style={[note, { fontVariant: ["tabular-nums"] }]}>{length}</Text>
      {copyright ? (
        <Text selectable style={note}>
          {copyright}
        </Text>
      ) : null}
    </View>
  );
}
