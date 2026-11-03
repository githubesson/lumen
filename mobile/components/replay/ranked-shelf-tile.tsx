import {
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import { albumCoverUrl } from "@music-library/core";
import { ShelfTile } from "../shelf-tile";
import { useTheme } from "../../theme/theme";

const TILE_SIZE = 128;

/**
 * Artwork for a shelf tile: an album's cover, or for an artist a cover from
 * their top tracks, falling back to a person glyph.
 */
type ShelfTileArt =
  | { kind: "album"; albumId: string }
  | { kind: "artist"; imageUrl: string | null };

/**
 * Ranked 128pt tile for the top-artists / top-albums shelves: artwork with
 * a rank badge, then title and detail lines. Press fires a haptic; the
 * caller supplies navigation.
 */
export function RankedShelfTile({
  rank,
  title,
  subtitle,
  subtitleTabular = false,
  accessibilityLabel,
  art,
  onPress,
  style,
}: {
  rank: number;
  title: string;
  subtitle: string;
  /** Render the subtitle with tabular digits (used for bare play counts). */
  subtitleTabular?: boolean;
  accessibilityLabel: string;
  art: ShelfTileArt;
  /** Omitted when the tile has nothing to open or play. */
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <ShelfTile
      artwork={
        art.kind === "artist" ? (
          <ArtistArt imageUrl={art.imageUrl} rank={rank} />
        ) : (
          <AlbumArt albumId={art.albumId} rank={rank} />
        )
      }
      title={title}
      subtitle={subtitle}
      subtitleTabular={subtitleTabular}
      width={TILE_SIZE}
      accessibilityLabel={accessibilityLabel}
      onPress={
        onPress
          ? () => {
              void Haptics.selectionAsync();
              onPress();
            }
          : undefined
      }
      style={style}
    />
  );
}

function ArtistArt({ imageUrl, rank }: { imageUrl: string | null; rank: number }) {
  const theme = useTheme();
  return (
    <View
      style={{
        width: TILE_SIZE,
        height: TILE_SIZE,
        borderRadius: theme.radius.md,
        borderCurve: "continuous",
        overflow: "hidden",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: theme.color.bgElev1,
      }}
    >
      {imageUrl ? (
        <Image
          source={{ uri: imageUrl }}
          style={{ width: TILE_SIZE, height: TILE_SIZE }}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={imageUrl}
        />
      ) : (
        <SymbolView name="person.fill" size={48} tintColor={theme.color.fgMuted} />
      )}
      <RankBadge rank={rank} />
    </View>
  );
}

function AlbumArt({ albumId, rank }: { albumId: string; rank: number }) {
  const theme = useTheme();
  return (
    <View
      style={{
        width: TILE_SIZE,
        height: TILE_SIZE,
        borderRadius: theme.radius.md,
        borderCurve: "continuous",
        overflow: "hidden",
        backgroundColor: theme.color.bgElev2,
      }}
    >
      <Image
        source={{ uri: albumCoverUrl(albumId, 256) }}
        style={{ width: TILE_SIZE, height: TILE_SIZE }}
        contentFit="cover"
        cachePolicy="memory-disk"
        recyclingKey={`album:${albumId}:${TILE_SIZE}`}
      />
      <RankBadge rank={rank} />
    </View>
  );
}

// Fixed scrim colors: the badge sits on top of artwork, so it must stay
// dark-on-light regardless of theme scheme.
function RankBadge({ rank }: { rank: number }) {
  return (
    <View
      style={{
        position: "absolute",
        top: 8,
        left: 8,
        minWidth: 24,
        height: 24,
        paddingHorizontal: 8,
        borderRadius: 12,
        backgroundColor: "rgba(0,0,0,0.6)",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        style={{
          color: "#FFFFFF",
          fontSize: 12,
          fontWeight: "600",
          fontVariant: ["tabular-nums"],
        }}
      >
        {rank}
      </Text>
    </View>
  );
}
