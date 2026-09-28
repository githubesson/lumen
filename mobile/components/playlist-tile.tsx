import { memo } from "react";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import type { Playlist } from "@music-library/core";
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
  const downloaded = usePlaylistDownloaded(playlist.id);
  const offline = useIsOffline();
  return (
    <ShelfTile
      style={offline && !downloaded ? { opacity: 0.4 } : undefined}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress(playlist);
      }}
      accessibilityLabel={`${playlist.name}, ${playlist.visibility}`}
      artwork={
        <PlaylistArtwork
          playlist={playlist}
          size={size}
          glyphSize={Math.round(size / 3)}
          radius={theme.radius.md}
        />
      }
      title={playlist.name}
      subtitle={
        (playlist.visibility === "collaborative" ? "Collaborative" : "Private") +
        (playlist.effective_role && playlist.effective_role !== "owner"
          ? ` - ${playlist.effective_role}`
          : "")
      }
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
  );
}

export const PlaylistTile = memo(PlaylistTileImpl);
