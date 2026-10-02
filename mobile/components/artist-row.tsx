import { memo } from "react";
import { View } from "react-native";
import { SymbolView } from "expo-symbols";
import {
  artistMetaParts,
  artistSubtitle,
  displayText,
  type Artist,
  type SearchArtist,
} from "@music-library/core";
import { ListRow } from "./list-row";
import { useTheme } from "../theme/theme";

interface Props<T extends Artist | SearchArtist> {
  artist: T;
  /** Receives the same object that was passed in as `artist`. */
  onPress: (artist: T) => void;
}

function ArtistRowImpl<T extends Artist | SearchArtist>({ artist, onPress }: Props<T>) {
  const theme = useTheme();
  const name = displayText(artist.name);
  return (
    <ListRow
      onPress={() => onPress(artist)}
      accessibilityLabel={[name, ...artistMetaParts(artist)].join(", ")}
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
      title={name}
      subtitle={artistSubtitle(artist)}
    />
  );
}

// memo() drops the type parameter; restore it so `onPress` stays typed to the
// row's own artist type.
export const ArtistRow = memo(ArtistRowImpl) as typeof ArtistRowImpl;
