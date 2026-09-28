import { memo } from "react";
import { SymbolView } from "expo-symbols";
import type { Playlist } from "@music-library/core";
import { ListRow } from "./list-row";
import { PlaylistArtwork } from "./playlist-artwork";
import { usePlaylistDownloaded } from "../lib/downloads";
import { useIsOffline } from "../lib/offline-mode";
import { useTheme } from "../theme/theme";

interface Props {
  playlist: Playlist;
  onPress: (p: Playlist) => void;
}

function PlaylistRowImpl({ playlist, onPress }: Props) {
  const theme = useTheme();
  const downloaded = usePlaylistDownloaded(playlist.id);
  const offline = useIsOffline();
  return (
    <ListRow
      style={offline && !downloaded ? { opacity: 0.4 } : undefined}
      onPress={() => onPress(playlist)}
      accessibilityLabel={`${playlist.name}, ${playlist.visibility}`}
      leading={<PlaylistArtwork playlist={playlist} size={40} glyphSize={20} />}
      title={playlist.name}
      trailing={
        downloaded ? (
          <SymbolView
            name="arrow.down.circle.fill"
            size={14}
            tintColor={theme.color.accent}
          />
        ) : undefined
      }
      subtitle={
        (playlist.visibility === "collaborative" ? "Collaborative" : "Private") +
        (playlist.effective_role && playlist.effective_role !== "owner"
          ? ` - ${playlist.effective_role}`
          : "")
      }
    />
  );
}

export const PlaylistRow = memo(PlaylistRowImpl);
