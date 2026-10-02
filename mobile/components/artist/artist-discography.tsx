import { useState } from "react";
import { View } from "react-native";
import * as Haptics from "expo-haptics";
import { displayText } from "@music-library/core";
import {
  filterReleases,
  hasReleaseFilters,
  RELEASE_FILTER_OPTIONS,
  releaseSubtitle,
  type ArtistRelease,
  type ReleaseFilter,
} from "@music-library/core/artist-releases";
import { CoverArt } from "../cover-art";
import { GlassSegmentedControl } from "../glass-segmented-control";
import { HorizontalShelf } from "../horizontal-shelf";
import { Section } from "../section";
import { ShelfTile } from "../shelf-tile";
import { useTheme } from "../../theme/theme";

const TILE_SIZE = 140;

/**
 * Discography shelf, newest first. When an artist has both albums and
 * singles/EPs, a segmented control narrows the shelf to one kind.
 */
export function ArtistDiscography({
  releases,
  onOpen,
}: {
  releases: ArtistRelease[];
  onOpen: (release: ArtistRelease) => void;
}) {
  const theme = useTheme();
  const [filter, setFilter] = useState<ReleaseFilter>("all");
  const shown = filterReleases(releases, filter);
  return (
    <Section title="Discography" style={{ gap: theme.space.md }}>
      {hasReleaseFilters(releases) ? (
        <View style={{ paddingHorizontal: theme.space.lg }}>
          <GlassSegmentedControl
            options={RELEASE_FILTER_OPTIONS}
            value={filter}
            onChange={setFilter}
          />
        </View>
      ) : null}
      <HorizontalShelf>
        {shown.map((release) => {
          const title = displayText(release.title);
          const subtitle = releaseSubtitle(release);
          return (
            <ShelfTile
              key={release.id}
              artwork={
                <CoverArt album={release} size={TILE_SIZE} priority="low" />
              }
              title={title}
              subtitle={subtitle}
              width={TILE_SIZE}
              accessibilityLabel={`${title}, ${subtitle}`}
              onPress={() => {
                void Haptics.selectionAsync();
                onOpen(release);
              }}
            />
          );
        })}
      </HorizontalShelf>
    </Section>
  );
}
