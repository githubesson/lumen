import { memo } from "react";
import { PixelRatio, StyleSheet, View } from "react-native";
import { Image, type ImageProps } from "expo-image";
import { albumCoverUrl, trackCoverUrl } from "@music-library/core";
import { useTheme } from "../theme/theme";

interface Props {
  /** Track source; cover URL comes from the shared `trackCoverUrl` helper. */
  track?: { id: string; album_id?: string | null; has_cover?: boolean };
  /** Album source; cover URL comes from `albumCoverUrl`. */
  album?: { id: string; has_cover?: boolean };
  size: number;
  transitionMs?: number;
  priority?: ImageProps["priority"];
  recyclingKey?: string;
  /** Corner radius override; defaults to the theme's small radius. Use 0 when a parent surface does the clipping. */
  radius?: number;
}

/**
 * Square cover artwork for a track or an album, reusing the shared URL
 * helpers so every row pointing at the same album hits the same URL and
 * benefits from the HTTP cache. Placeholder is a subtle background so
 * empty-state isn't jarring.
 */
function CoverArtImpl({
  track,
  album,
  size,
  transitionMs = 120,
  priority,
  recyclingKey,
  radius,
}: Props) {
  const theme = useTheme();
  const requestSize = Math.max(1, Math.round(size * PixelRatio.get()));
  const shouldLoadCover = (track ?? album)?.has_cover !== false;
  const uri = track
    ? trackCoverUrl(track, requestSize)
    : album
      ? albumCoverUrl(album.id, requestSize)
      : undefined;
  return (
    <View
      style={[
        styles.frame,
        {
          width: size,
          height: size,
          borderRadius: radius ?? theme.radius.sm,
          backgroundColor: theme.color.bgElev2,
        },
      ]}
    >
      {shouldLoadCover && uri ? (
        <Image
          source={{ uri }}
          style={{ width: size, height: size }}
          contentFit="cover"
          transition={transitionMs}
          cachePolicy="memory-disk"
          priority={priority}
          allowDownscaling
          decodeFormat="rgb"
          recyclingKey={
            recyclingKey ??
            `${track ? (track.album_id ?? track.id) : album?.id}:${requestSize}`
          }
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    overflow: "hidden",
    borderCurve: "continuous",
  },
});

export const CoverArt = memo(CoverArtImpl);
