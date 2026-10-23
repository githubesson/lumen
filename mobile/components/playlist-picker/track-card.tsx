import type { Ref } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import { displayText, type TrackListItem } from "@music-library/core";
import { formatDurationMs } from "../../lib/format";
import { PICKER_MAX_FONT_SCALE } from "./picker-row";
import { useTheme, withAlpha } from "../../theme/theme";

export const TRACK_CARD_COVER_SIZE = 48;

/**
 * The track being added, at the top of the picker: cover, title,
 * "artist · album" and length. `lifted` hides the cover once it has flown
 * off to the confirmation.
 */
export function TrackCard({
  track,
  coverUri,
  coverRef,
  lifted,
}: {
  track: TrackListItem | undefined;
  coverUri: string | null;
  coverRef: Ref<View>;
  lifted: boolean;
}) {
  const theme = useTheme();
  const title = track ? displayText(track.title) : "Add to Playlist";
  const names = track
    ? [displayText(track.artist), displayText(track.album_title)].filter(Boolean)
    : [];
  const duration = track ? formatDurationMs(track.duration_ms) : "";

  return (
    <View
      accessible
      accessibilityLabel={[title, ...names, duration].filter(Boolean).join(", ")}
      style={[styles.card, { backgroundColor: withAlpha(theme.color.fg, 0.07) }]}
    >
      <View
        ref={coverRef}
        collapsable={false}
        style={[
          styles.cover,
          { backgroundColor: theme.color.bgElev2, opacity: lifted ? 0 : 1 },
        ]}
      >
        {coverUri ? (
          <Image
            source={{ uri: coverUri }}
            style={styles.image}
            contentFit="cover"
            transition={0}
            cachePolicy="memory-disk"
            allowDownscaling
            decodeFormat="rgb"
          />
        ) : (
          <SymbolView
            name="music.note"
            size={20}
            tintColor={theme.color.fgMuted}
          />
        )}
      </View>
      <View style={styles.text}>
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={PICKER_MAX_FONT_SCALE}
          style={{ color: theme.color.fg, fontSize: 16, fontWeight: "600" }}
        >
          {title}
        </Text>
        {names.length > 0 ? (
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={PICKER_MAX_FONT_SCALE}
            style={{ color: theme.color.fgMuted, fontSize: 13 }}
          >
            {names.join(" · ")}
          </Text>
        ) : null}
      </View>
      {duration ? (
        <Text
          maxFontSizeMultiplier={PICKER_MAX_FONT_SCALE}
          style={{
            color: theme.color.fgMuted,
            fontSize: 13,
            fontVariant: ["tabular-nums"],
          }}
        >
          {duration}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    paddingLeft: 10,
    paddingRight: 14,
    borderRadius: 18,
    borderCurve: "continuous",
  },
  cover: {
    width: TRACK_CARD_COVER_SIZE,
    height: TRACK_CARD_COVER_SIZE,
    borderRadius: 8,
    borderCurve: "continuous",
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  image: {
    width: TRACK_CARD_COVER_SIZE,
    height: TRACK_CARD_COVER_SIZE,
  },
  text: {
    flex: 1,
    minWidth: 0,
  },
});
