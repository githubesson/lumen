import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { TrackListItem } from "@music-library/core";
import { CoverArt } from "./cover-art";
import { DOCK, useDockColors } from "./dock/dock-context";
import { DockSurface } from "./dock/dock-surface";
import { formatDurationMs } from "../lib/format";
import { useTrackRowPresentation } from "../lib/use-track-row-presentation";

/** Keeps the pill phone-sized on iPad instead of spanning the screen. */
const PREVIEW_MAX_WIDTH = 480;
const COVER_SIZE = 36;

/**
 * What press-and-hold lifts above the track menu: the track on the dock's
 * own glass pill, sized like the phone mini-player. Every row carries one, so
 * the glass and artwork mount only while `active` (a press held, or the menu
 * open); until then the pill is the dock's scrim and the track's text.
 *
 * The root view must stay the same view for the row's life: SwiftUI hosts
 * that exact view in the preview, so a swapped-in root never shows.
 */
export function TrackMenuPreview({
  track,
  active,
}: {
  track: TrackListItem;
  active: boolean;
}) {
  const { width } = useWindowDimensions();
  const colors = useDockColors();
  const presentation = useTrackRowPresentation(track);
  const size = {
    width: Math.min(width - DOCK.phoneMiniMargin * 2, PREVIEW_MAX_WIDTH),
    height: DOCK.miniHeight,
  };
  return (
    <View
      collapsable={false}
      pointerEvents="none"
      style={[styles.pill, size, { borderColor: colors.border }]}
    >
      {active ? (
        <DockSurface />
      ) : (
        <View
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]}
        />
      )}
      <View style={[styles.row, presentation.dimmed && styles.dimmed]}>
        {active ? (
          <CoverArt track={track} size={COVER_SIZE} transitionMs={0} />
        ) : (
          <View style={styles.cover} />
        )}
        <View style={styles.meta}>
          <Text
            numberOfLines={1}
            style={{ fontSize: 15, fontWeight: "600", color: colors.active }}
          >
            {presentation.title}
          </Text>
          {presentation.subtitle ? (
            <Text numberOfLines={1} style={{ fontSize: 13, color: colors.muted }}>
              {presentation.subtitle}
            </Text>
          ) : null}
        </View>
        <Text style={{ fontSize: 13, color: colors.muted }}>
          {formatDurationMs(track.duration_ms)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderRadius: DOCK.miniHeight / 2,
    borderCurve: "continuous",
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 12,
    paddingRight: 18,
  },
  // Fades the content only: alpha on the glass or its ancestors drops the
  // effect for good (see DockSurface).
  dimmed: {
    opacity: 0.4,
  },
  cover: {
    width: COVER_SIZE,
    height: COVER_SIZE,
  },
  meta: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 2,
  },
});
