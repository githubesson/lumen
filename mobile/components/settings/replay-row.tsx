import { useMemo } from "react";
import { PixelRatio, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  replayRequest,
  useLocalDay,
  type ApiError,
  type Period,
  type ReplayData,
} from "@music-library/core";
import { SETTINGS_INSET } from "./settings-card";
import { subscribeAppActive } from "../../lib/app-resume";
import { qk } from "../../lib/query-keys";
import { QUERY_STALE_TIME } from "../../lib/query-policy";
import { replayTeaser, type ReplayTeaser } from "../../lib/settings/replay-teaser";
import { useTheme } from "../../theme/theme";

const THIS_YEAR: Period = { kind: "this-year" };
const COLLAGE = 46;

export interface ReplayYearTeaser extends ReplayTeaser {
  year: number;
}

/**
 * This year's Replay, for the Settings row: the same query (and cache entry)
 * the Replay screen opens on, so either one warms the other.
 */
export function useReplayTeaser(): ReplayYearTeaser {
  // Recomputed when the local day changes, as on the Replay screen, so the
  // year (and its cache key) roll over on New Year's Day.
  const today = useLocalDay(subscribeAppActive);
  const request = useMemo(
    () => ({ ...replayRequest(THIS_YEAR), asOf: today }),
    [today],
  );
  const { range } = request;
  const query = useQuery<ReplayData, ApiError>({
    queryKey: qk.replay(request.cacheKey),
    queryFn: ({ signal }) => api.getReplay(range, { signal }),
    staleTime: QUERY_STALE_TIME.replay,
  });
  const data = query.data;
  const teaser = useMemo(
    () => replayTeaser(data, Math.round(COLLAGE * PixelRatio.get())),
    [data],
  );
  // The range starts on 1 January (UTC) of the year it covers.
  const year = Number(range.from?.slice(0, 4)) || new Date().getFullYear();
  return { ...teaser, year };
}

/** "Replay 2026 · <artist> on top" with a collage of the top covers; opens Replay. */
export function ReplayRow({
  teaser,
  onPress,
}: {
  teaser: ReplayYearTeaser;
  onPress: () => void;
}) {
  const theme = useTheme();
  const title = `Replay ${teaser.year}`;
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={teaser.subtitle ? `${title}, ${teaser.subtitle}` : title}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? theme.color.bgElev2 : "transparent" },
      ]}
    >
      <Collage covers={teaser.covers} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: theme.color.fg, fontSize: 16 }}>
          {title}
        </Text>
        {teaser.subtitle ? (
          <Text numberOfLines={1} style={{ color: theme.color.fgMuted, fontSize: 13 }}>
            {teaser.subtitle}
          </Text>
        ) : null}
      </View>
      <SymbolView name="chevron.right" size={14} tintColor={theme.color.fgMuted} />
    </Pressable>
  );
}

/**
 * Two-by-two top covers. One cover fills the tile; two or three repeat to
 * fill the grid (as the playlist hero does); none shows Replay's sparkles.
 */
function Collage({ covers }: { covers: string[] }) {
  const theme = useTheme();
  const cells = useMemo(() => {
    if (covers.length <= 1) return covers;
    const filled = [...covers];
    while (filled.length < 4) filled.push(covers[filled.length % covers.length]);
    return filled.slice(0, 4);
  }, [covers]);
  const cell = cells.length === 1 ? COLLAGE : COLLAGE / 2;
  return (
    <View style={[styles.collage, { backgroundColor: theme.color.bgElev2 }]}>
      {cells.length === 0 ? (
        <SymbolView name="sparkles" size={20} tintColor={theme.color.fgMuted} />
      ) : (
        cells.map((uri, index) => (
          <Image
            key={`${uri}:${index}`}
            source={{ uri }}
            style={{ width: cell, height: cell }}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={120}
            recyclingKey={`${uri}:${index}`}
          />
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: SETTINGS_INSET,
    paddingVertical: 10,
  },
  collage: {
    width: COLLAGE,
    height: COLLAGE,
    borderRadius: 8,
    borderCurve: "continuous",
    overflow: "hidden",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
  },
});
