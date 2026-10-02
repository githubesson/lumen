import { memo } from "react";
import { PixelRatio, View } from "react-native";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import { playlistArtUrl, type Playlist } from "@music-library/core";
import { useImageFailure } from "../lib/use-image-failure";
import { useTheme } from "../theme/theme";

interface Props {
  playlist: Playlist;
  size: number;
  glyphSize: number;
  /** Defaults to the theme's small radius. */
  radius?: number;
  /** Tile colour behind the glyph (and behind artwork while it loads). */
  background?: string;
}

/**
 * Square artwork for a playlist in a list: the owner's uploaded cover, else
 * its first track's art, else the list glyph rows showed before covers.
 */
function PlaylistArtworkImpl({ playlist, size, glyphSize, radius, background }: Props) {
  const theme = useTheme();
  const uri = playlistArtUrl(playlist, Math.round(size * PixelRatio.get()));
  const failure = useImageFailure(uri);
  const showImage = uri != null && !failure.failed;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius ?? theme.radius.sm,
        overflow: "hidden",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: background ?? theme.color.bgElev2,
        borderCurve: "continuous",
      }}
    >
      {showImage ? (
        <Image
          source={{ uri }}
          style={{ width: size, height: size }}
          contentFit="cover"
          transition={120}
          cachePolicy="memory-disk"
          allowDownscaling
          decodeFormat="rgb"
          recyclingKey={uri}
          onError={failure.onError}
        />
      ) : (
        <SymbolView
          name={
            playlist.visibility === "collaborative"
              ? "person.2.fill"
              : "music.note.list"
          }
          size={glyphSize}
          tintColor={theme.color.fgMuted}
        />
      )}
    </View>
  );
}

export const PlaylistArtwork = memo(PlaylistArtworkImpl);
