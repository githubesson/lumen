import { memo, useRef } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from "react-native";
import { SymbolView } from "expo-symbols";
import type { Playlist } from "@music-library/core";
import { PlaylistArtwork } from "../playlist-artwork";
import type { AddTarget } from "../../lib/add-to-playlist";
import { useTheme, withAlpha, type ThemeTokens } from "../../theme/theme";

/** Fixed, so the list never measures a row. */
export const PICKER_ROW_HEIGHT = 60;
/**
 * Text in the picker grows with Dynamic Type up to this much. A row's two
 * lines then take about 26 + 20 pt of its 60, and the badge's line fits its
 * 24; the largest accessibility sizes would clip or overlap.
 */
export const PICKER_MAX_FONT_SCALE = 1.25;
export const PICKER_ART_SIZE = 44;
const ART_RADIUS = 8;

/**
 * `row` is the pressed row's view and `event` the press: together they place
 * the card's cover on screen for the confirmation's flight.
 */
export type PickHandler = (
  target: AddTarget,
  row: View | null,
  event: GestureResponderEvent,
) => void;

/**
 * Only the exceptions get a subtitle: a shared playlist names its owner
 * (or just that it's shared, when it's yours).
 */
function collaborativeSubtitle(playlist: Playlist): string | null {
  if (playlist.visibility !== "collaborative") return null;
  return playlist.effective_role !== "owner" && playlist.owner_name
    ? `${playlist.owner_name} · Collaborative`
    : "Collaborative";
}

export const PlaylistPickerRow = memo(function PlaylistPickerRow({
  playlist,
  pending,
  onPick,
}: {
  playlist: Playlist;
  /**
   * Whether it already holds the track isn't known yet. The row ignores
   * taps without fading: the answer is usually one quick request away, the
   * search field shows a spinner when it isn't, and the picker lets go of
   * the rows after a few seconds.
   */
  pending: boolean;
  onPick: PickHandler;
}) {
  const theme = useTheme();
  const ref = useRef<View>(null);
  // Only a server that knows the field marks anything; without it every
  // playlist stays pickable.
  const added = playlist.contains_track === true;
  const subtitle = collaborativeSubtitle(playlist);

  return (
    <Pressable
      ref={ref}
      // The press lands on the row itself, so its location is in the row.
      pointerEvents="box-only"
      disabled={added || pending}
      onPress={(event) => onPick({ kind: "existing", playlist }, ref.current, event)}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${playlist.name}, ${subtitle}` : playlist.name}
      accessibilityValue={added ? { text: "Added" } : undefined}
      accessibilityHint={
        added
          ? "Already has this track."
          : pending
            ? "Checking whether it already has this track."
            : "Adds the track to this playlist."
      }
      accessibilityState={{ disabled: added || pending, busy: pending }}
      style={({ pressed }) => rowStyle(theme, pressed, added)}
    >
      <PlaylistArtwork
        playlist={playlist}
        size={PICKER_ART_SIZE}
        glyphSize={19}
        radius={ART_RADIUS}
      />
      <View style={[styles.body, { borderBottomColor: theme.color.separator }]}>
        <View style={styles.text}>
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={PICKER_MAX_FONT_SCALE}
            style={[styles.name, { color: theme.color.fg }]}
          >
            {playlist.name}
          </Text>
          {subtitle ? (
            <Text
              numberOfLines={1}
              maxFontSizeMultiplier={PICKER_MAX_FONT_SCALE}
              style={[styles.subtitle, { color: theme.color.fgMuted }]}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
        {added ? <AddedBadge /> : null}
      </View>
    </Pressable>
  );
});

/** The row a search offers when no playlist has that name: makes one. */
export const NewPlaylistRow = memo(function NewPlaylistRow({
  name,
  onPick,
}: {
  name: string;
  onPick: PickHandler;
}) {
  const theme = useTheme();
  const ref = useRef<View>(null);

  return (
    <Pressable
      ref={ref}
      pointerEvents="box-only"
      onPress={(event) => onPick({ kind: "new", name }, ref.current, event)}
      accessibilityRole="button"
      accessibilityLabel={`New playlist, ${name}`}
      accessibilityHint="Makes the playlist and adds the track."
      style={({ pressed }) => rowStyle(theme, pressed, false)}
    >
      <View
        style={[
          styles.newArt,
          { backgroundColor: withAlpha(theme.color.accent, 0.22) },
        ]}
      >
        <SymbolView name="plus" size={22} tintColor={theme.color.accent} />
      </View>
      <View style={[styles.body, { borderBottomColor: theme.color.separator }]}>
        <View style={styles.text}>
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={PICKER_MAX_FONT_SCALE}
            style={[styles.name, { color: theme.color.fg }]}
          >
            {name}
          </Text>
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={PICKER_MAX_FONT_SCALE}
            style={[styles.subtitle, { color: theme.color.accent }]}
          >
            New Playlist
          </Text>
        </View>
      </View>
    </Pressable>
  );
});

function AddedBadge() {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor:
            theme.scheme === "dark"
              ? "rgba(118,118,128,0.18)"
              : "rgba(116,116,128,0.08)",
        },
      ]}
    >
      <SymbolView
        name="checkmark"
        size={12}
        weight="semibold"
        tintColor={theme.color.fgMuted}
      />
      <Text
        maxFontSizeMultiplier={PICKER_MAX_FONT_SCALE}
        style={[styles.badgeText, { color: theme.color.fgMuted }]}
      >
        Added
      </Text>
    </View>
  );
}

function rowStyle(theme: ThemeTokens, pressed: boolean, dimmed: boolean) {
  return [
    styles.row,
    {
      backgroundColor: pressed ? withAlpha(theme.color.fg, 0.08) : "transparent",
      opacity: dimmed ? 0.55 : 1,
    },
  ];
}

const styles = StyleSheet.create({
  row: {
    height: PICKER_ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
  },
  body: {
    flex: 1,
    minWidth: 0,
    height: PICKER_ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    fontSize: 17,
    fontWeight: "500",
  },
  subtitle: {
    fontSize: 13,
  },
  newArt: {
    width: PICKER_ART_SIZE,
    height: PICKER_ART_SIZE,
    borderRadius: ART_RADIUS,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    height: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingLeft: 7,
    paddingRight: 9,
    borderRadius: 12,
  },
  badgeText: {
    fontSize: 13,
    fontWeight: "500",
  },
});
