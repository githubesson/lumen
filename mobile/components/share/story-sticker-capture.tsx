import { forwardRef } from "react";
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Image } from "expo-image";
import { type PublicTrackShare } from "@music-library/core";

/** Logical sticker canvas size; capture multiplies by the scale below. */
export const STORY_STICKER_WIDTH = 720;
export const STORY_STICKER_CAPTURE_SCALE = 2;

const STORY_STICKER_HEIGHT = 925;
const STORY_STICKER_TITLE_LINE_HEIGHT = 56;
const STORY_STICKER_TITLE_MAX_LINES = 3;
const STORY_STICKER_TITLE_UNITS_PER_LINE = 22;

/**
 * Offscreen Instagram-story sticker card rendered only while a story share is
 * being prepared, then rasterized with react-native-view-shot via the
 * forwarded ref. Colors are intentionally fixed (not theme tokens) because
 * the capture must look identical on top of any story background.
 * `onCoverLoadEnd` fires once the cover image is decoded so the caller knows
 * it is safe to capture.
 */
export const StoryStickerCapture = forwardRef<View, {
  share: PublicTrackShare | null;
  onCoverLoadEnd: () => void;
  style?: StyleProp<ViewStyle>;
}>(({ share, onCoverLoadEnd, style }, ref) => {
  const title = share?.title?.trim() || "Untitled track";
  const artist = share?.artist?.trim() || "Unknown artist";
  const titleLineCount = getStoryStickerTitleLineCount(title);
  const stickerHeight = getStoryStickerHeight(title);
  const wrappedTitle = titleLineCount > 1;

  return (
    <View
      pointerEvents="none"
      style={[
        styles.storyStickerHost,
        wrappedTitle && { height: stickerHeight },
        style,
      ]}
    >
      <View
        ref={ref}
        collapsable={false}
        style={[
          styles.storyStickerCard,
          wrappedTitle && { height: stickerHeight },
        ]}
      >
        {share?.cover_url ? (
          <Image
            source={{ uri: share.cover_url }}
            style={styles.storyStickerCover}
            contentFit="cover"
            cachePolicy="memory-disk"
            priority="high"
            transition={0}
            onLoadEnd={onCoverLoadEnd}
          />
        ) : (
          <View style={styles.storyStickerCoverFallback} />
        )}
        <Text
          numberOfLines={titleLineCount}
          ellipsizeMode="tail"
          style={styles.storyStickerTitle}
        >
          {title}
        </Text>
        <Text
          numberOfLines={1}
          style={styles.storyStickerArtist}
        >
          {artist}
        </Text>
        <View style={styles.storyStickerBrand}>
          <LumenWaveformMark />
          <Text style={styles.storyStickerBrandText}>Lumen</Text>
        </View>
      </View>
    </View>
  );
});

StoryStickerCapture.displayName = "StoryStickerCapture";

/** Sticker canvas height for a title, growing per wrapped title line. */
export function getStoryStickerHeight(title?: string | null) {
  const lineCount = getStoryStickerTitleLineCount(
    title?.trim() || "Untitled track",
  );
  return (
    STORY_STICKER_HEIGHT +
    (lineCount - 1) * STORY_STICKER_TITLE_LINE_HEIGHT
  );
}

function getStoryStickerTitleLineCount(title: string) {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;

  let lineCount = 1;
  let lineUnits = 0;

  for (const word of words) {
    const wordUnits = getStoryStickerTitleUnits(word);
    const separatorUnits = lineUnits === 0 ? 0 : 0.6;

    if (
      lineUnits > 0 &&
      lineUnits + separatorUnits + wordUnits >
        STORY_STICKER_TITLE_UNITS_PER_LINE
    ) {
      lineCount += 1;
      lineUnits = wordUnits;
    } else {
      lineUnits += separatorUnits + wordUnits;
    }

    if (lineCount >= STORY_STICKER_TITLE_MAX_LINES) {
      return STORY_STICKER_TITLE_MAX_LINES;
    }
  }

  return lineCount;
}

function getStoryStickerTitleUnits(text: string) {
  return Array.from(text).reduce((total, char) => {
    if (/[A-Z]/.test(char)) return total + 1.12;
    if (/[il.,'!:;]/.test(char)) return total + 0.42;
    if (/[-&()[\]/]/.test(char)) return total + 0.65;
    return total + 0.95;
  }, 0);
}

/** The Lumen waveform logomark, drawn from rotated line segments. */
function LumenWaveformMark() {
  return (
    <View style={styles.lumenWaveform}>
      {[
        [0, 17, 5, 17],
        [5, 17, 9, 8],
        [9, 8, 15, 29],
        [15, 29, 22, 3],
        [22, 3, 30, 33],
        [30, 33, 37, 13],
        [37, 13, 42, 17],
      ].map(([x1, y1, x2, y2], index) => {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.hypot(dx, dy);
        const angle = `${Math.atan2(dy, dx)}rad`;
        return (
          <View
            key={index}
            style={[
              styles.lumenWaveformSegment,
              {
                width: length,
                left: x1,
                top: y1,
                transform: [{ rotate: angle }],
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  storyStickerHost: {
    position: "absolute",
    left: -2000,
    top: -2000,
    width: 720,
    height: 925,
  },
  storyStickerCard: {
    width: 720,
    height: 925,
    padding: 45,
    borderRadius: 34,
    borderCurve: "continuous",
    backgroundColor: "#FFFFFF",
    overflow: "hidden",
  },
  storyStickerCover: {
    width: 630,
    height: 630,
    borderRadius: 9,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  storyStickerCoverFallback: {
    width: 630,
    height: 630,
    borderRadius: 9,
    borderCurve: "continuous",
    backgroundColor: "#E8E9EE",
  },
  storyStickerTitle: {
    marginTop: 31,
    color: "#050505",
    fontSize: 50,
    lineHeight: 56,
    fontWeight: "800",
    letterSpacing: 0,
  },
  storyStickerArtist: {
    color: "#101014",
    fontSize: 44,
    lineHeight: 54,
    fontWeight: "400",
    letterSpacing: 0,
  },
  storyStickerBrand: {
    marginTop: 22,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  storyStickerBrandText: {
    color: "#BCBEC4",
    fontSize: 36,
    lineHeight: 42,
    fontWeight: "700",
    letterSpacing: 0,
  },
  lumenWaveform: {
    width: 44,
    height: 36,
  },
  lumenWaveformSegment: {
    position: "absolute",
    height: 5,
    borderRadius: 3,
    backgroundColor: "#BCBEC4",
    transformOrigin: "left center",
  },
});
