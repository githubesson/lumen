import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { albumCoverUrl } from "@music-library/core";
import { ShelfTile } from "../shelf-tile";
import { useTheme } from "../../theme/theme";

const TILE_SIZE = 128;

/**
 * Artwork for a shelf tile: either a real album cover or a deterministic
 * two-tone gradient seeded by a string (for artists without cover art).
 */
export type ShelfTileArt =
  | { kind: "album"; albumId: string }
  | { kind: "gradient"; seed: string };

// Deterministic hue seeded by a string, used for artist tiles that have
// no real cover art.
function hueFor(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

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
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <ShelfTile
      artwork={
        art.kind === "gradient" ? (
          <GradientArt seed={art.seed} rank={rank} />
        ) : (
          <AlbumArt albumId={art.albumId} rank={rank} />
        )
      }
      title={title}
      subtitle={subtitle}
      subtitleTabular={subtitleTabular}
      width={TILE_SIZE}
      accessibilityLabel={accessibilityLabel}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      style={style}
    />
  );
}

function GradientArt({ seed, rank }: { seed: string; rank: number }) {
  const theme = useTheme();
  const hue = hueFor(seed);
  return (
    <View
      style={{
        width: TILE_SIZE,
        height: TILE_SIZE,
        borderRadius: theme.radius.md,
        borderCurve: "continuous",
        overflow: "hidden",
        backgroundColor: `hsl(${hue}, 50%, 50%)`,
      }}
    >
      <View
        style={{
          ...StyleSheet.absoluteFillObject,
          backgroundColor: `hsl(${(hue + 40) % 360}, 60%, 35%)`,
          opacity: 0.55,
        }}
      />
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
        top: 6,
        left: 6,
        minWidth: 22,
        height: 22,
        paddingHorizontal: 7,
        borderRadius: 999,
        backgroundColor: "rgba(0,0,0,0.6)",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        style={{
          color: "#FFFFFF",
          fontSize: 11,
          fontWeight: "600",
          fontVariant: ["tabular-nums"],
        }}
      >
        {rank}
      </Text>
    </View>
  );
}
