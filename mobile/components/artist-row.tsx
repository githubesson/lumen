import { memo } from "react";
import { View } from "react-native";
import { SymbolView } from "expo-symbols";
import type { Artist } from "@music-library/core";
import { ListRow } from "./list-row";
import { useTheme } from "../theme/theme";

interface Props {
  artist: Artist;
  onPress: (artist: Artist) => void;
}

function ArtistRowImpl({ artist, onPress }: Props) {
  const theme = useTheme();
  return (
    <ListRow
      onPress={() => onPress(artist)}
      accessibilityLabel={`${artist.name}, ${artist.track_count} tracks`}
      leading={
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: theme.color.bgElev2,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <SymbolView
            name="person.fill"
            size={18}
            tintColor={theme.color.fgMuted}
          />
        </View>
      }
      title={artist.name}
      subtitle={
        `${artist.track_count} ${artist.track_count === 1 ? "track" : "tracks"}` +
        (artist.album_count
          ? ` - ${artist.album_count} ${artist.album_count === 1 ? "album" : "albums"}`
          : "")
      }
    />
  );
}

export const ArtistRow = memo(ArtistRowImpl);
