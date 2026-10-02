import { memo } from "react";
import { View } from "react-native";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { playlistSubtitle, type Playlist } from "@music-library/core";
import { PlaylistArtwork } from "./playlist-artwork";
import { ShelfTile } from "./shelf-tile";
import { usePlaylistDownloaded } from "../lib/downloads";
import { useIsOffline } from "../lib/offline-mode";
import { useTheme } from "../theme/theme";

interface Props {
  playlist: Playlist;
  size: number;
  onPress: (p: Playlist) => void;
}

/** Grid tile for the playlists tab: large artwork over name and visibility. */
function PlaylistTileImpl({ playlist, size, onPress }: Props) {
  const theme = useTheme();
  const subtitle = playlistSubtitle(playlist);
  const downloaded = usePlaylistDownloaded(playlist.id);
  const offline = useIsOffline();
  // Dim on a wrapper so it multiplies with ShelfTile's pressed fade instead
  // of replacing it.
  return (
    <View style={offline && !downloaded ? { opacity: 0.4 } : undefined}>
      <ShelfTile
        onPress={() => {
          void Haptics.selectionAsync();
          onPress(playlist);
        }}
        accessibilityLabel={`${playlist.name}, ${subtitle}`}
        artwork={
          <PlaylistArtwork
            playlist={playlist}
            size={size}
            glyphSize={Math.round(size / 3)}
            radius={theme.radius.md}
          />
        }
        title={playlist.name}
        subtitle={subtitle}
        subtitleAccessory={
          downloaded ? (
            <SymbolView
              name="arrow.down.circle.fill"
              size={12}
              tintColor={theme.color.accent}
            />
          ) : undefined
        }
        width={size}
      />
    </View>
  );
}

export const PlaylistTile = memo(PlaylistTileImpl);
