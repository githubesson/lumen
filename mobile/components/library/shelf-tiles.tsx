import { View } from "react-native";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { albumCoverUrl, displayText, type TrackListItem } from "@music-library/core";
import type { StyleProp, ViewStyle } from "react-native";
import { CoverArt } from "../cover-art";
import { ShelfTile } from "../shelf-tile";
import { useTheme } from "../../theme/theme";

const SHELF_TILE_SIZE = 124;

/**
 * Track tile for horizontal home shelves. Fires a selection haptic, then
 * hands the track to the shelf's play-queue handler.
 */
export function TrackTile({
  track,
  onPress,
  style,
}: {
  track: TrackListItem;
  onPress: (t: TrackListItem) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const title = displayText(track.title);
  const artist = displayText(track.artist);
  return (
    <ShelfTile
      artwork={<CoverArt track={track} size={SHELF_TILE_SIZE} priority="low" />}
      title={title}
      subtitle={artist || undefined}
      width={SHELF_TILE_SIZE}
      accessibilityLabel={artist ? `${title} by ${artist}` : title}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress(track);
      }}
      style={style}
    />
  );
}

/**
 * Album tile for horizontal home shelves. Haptics belong to the caller's
 * navigation handler, so pressing simply reports the album id.
 */
export function AlbumTile({
  id,
  title: rawTitle,
  subtitle: rawSubtitle,
  onPress,
  style,
}: {
  id: string;
  title: string;
  subtitle?: string;
  onPress: (id: string) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const title = displayText(rawTitle);
  const subtitle = displayText(rawSubtitle) || undefined;
  return (
    <ShelfTile
      artwork={
        <View
          style={{
            width: SHELF_TILE_SIZE,
            height: SHELF_TILE_SIZE,
            borderRadius: theme.radius.sm,
            borderCurve: "continuous",
            overflow: "hidden",
            backgroundColor: theme.color.bgElev2,
          }}
        >
          <Image
            source={{ uri: albumCoverUrl(id, 256) }}
            style={{ width: SHELF_TILE_SIZE, height: SHELF_TILE_SIZE }}
            contentFit="cover"
            cachePolicy="memory-disk"
            recyclingKey={`album:${id}:${SHELF_TILE_SIZE}`}
          />
        </View>
      }
      title={title}
      subtitle={subtitle}
      width={SHELF_TILE_SIZE}
      accessibilityLabel={subtitle ? `${title} by ${subtitle}` : title}
      onPress={() => onPress(id)}
      style={style}
    />
  );
}
