import { memo } from "react";
import { View } from "react-native";
import { SymbolView } from "expo-symbols";
import type { Playlist } from "@music-library/core";
import { ListRow } from "./list-row";
import { useTheme } from "../theme/theme";

interface Props {
  playlist: Playlist;
  onPress: (p: Playlist) => void;
}

function PlaylistRowImpl({ playlist, onPress }: Props) {
  const theme = useTheme();
  return (
    <ListRow
      onPress={() => onPress(playlist)}
      accessibilityLabel={`${playlist.name}, ${playlist.visibility}`}
      leading={
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: theme.radius.sm,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.color.bgElev2,
            borderCurve: "continuous",
          }}
        >
          <SymbolView
            name={
              playlist.visibility === "collaborative"
                ? "person.2.fill"
                : "music.note.list"
            }
            size={20}
            tintColor={theme.color.fgMuted}
          />
        </View>
      }
      title={playlist.name}
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
