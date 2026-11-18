import { Pressable, Text, View } from "react-native";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { displayText } from "@music-library/core";
import { releaseSubtitle, type ArtistRelease } from "@music-library/core/artist-releases";
import { CoverArt } from "./cover-art";
import { HorizontalShelf } from "./horizontal-shelf";
import { ShelfTile } from "./shelf-tile";
import { useTheme } from "../theme/theme";

const TILE_SIZE = 140;

/**
 * The album artist's other releases, at the foot of an album page. The
 * heading opens the artist's page when there is one; nothing shows when the
 * artist has no other release.
 */
export function AlbumMoreBy({
  artist,
  releases,
  onOpenArtist,
  onOpenRelease,
  inset = 0,
}: {
  artist: string;
  releases: ArtistRelease[];
  onOpenArtist?: () => void;
  onOpenRelease: (release: ArtistRelease) => void;
  /** The centred cover's inset on an iPad (`useAlbumCoverInset`). */
  inset?: number;
}) {
  const theme = useTheme();
  if (releases.length === 0 || !artist) return null;
  const title = `More by ${artist}`;
  const heading = (
    <>
      <Text
        numberOfLines={1}
        style={{
          flexShrink: 1,
          color: theme.color.fg,
          fontSize: 20,
          fontWeight: "600",
          letterSpacing: -0.2,
        }}
      >
        {title}
      </Text>
      {onOpenArtist ? (
        <SymbolView
          name="chevron.forward"
          size={15}
          weight="semibold"
          tintColor={theme.color.fgMuted}
        />
      ) : null}
    </>
  );
  return (
    <View style={{ paddingTop: theme.space.xl, gap: theme.space.md }}>
      {onOpenArtist ? (
        // A link, like the hero's artist name: VoiceOver lists it with the
        // page's other links rather than as a plain heading.
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={title}
          accessibilityHint="Opens the artist"
          onPress={() => {
            void Haptics.selectionAsync();
            onOpenArtist();
          }}
          hitSlop={8}
          style={({ pressed }) => ({
            alignSelf: "flex-start",
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            marginHorizontal: inset + theme.space.lg,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          {heading}
        </Pressable>
      ) : (
        <View
          accessibilityRole="header"
          style={{ flexDirection: "row", marginHorizontal: inset + theme.space.lg }}
        >
          {heading}
        </View>
      )}
      <HorizontalShelf inset={inset}>
        {releases.map((release) => {
          const name = displayText(release.title);
          const subtitle = releaseSubtitle(release);
          return (
            <ShelfTile
              key={release.id}
              artwork={<CoverArt album={release} size={TILE_SIZE} priority="low" />}
              title={name}
              subtitle={subtitle}
              width={TILE_SIZE}
              accessibilityLabel={subtitle ? `${name}, ${subtitle}` : name}
              onPress={() => {
                void Haptics.selectionAsync();
                onOpenRelease(release);
              }}
            />
          );
        })}
      </HorizontalShelf>
    </View>
  );
}
