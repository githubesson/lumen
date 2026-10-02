import { Pressable, Text, View } from "react-native";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import type { TrackListItem } from "@music-library/core";
import {
  listPlaybackState,
  startListPlayback,
} from "@music-library/core/player/play-list";
import {
  useCurrentTrack,
  usePlayerControls,
  usePlayerPlayback,
  usePlayTrack,
  useRemotePlayback,
} from "../../context/player";
import { listPlaybackQueue } from "../../lib/offline-mode";
import { useTheme } from "../../theme/theme";

const PLAY_SIZE = 56;
const SHUFFLE_SIZE = 44;

/**
 * Stats on the left; shuffle toggle and the round play button on the right.
 * Play starts the artist's list (from a random track when shuffle is on) and
 * turns into pause while one of those tracks is the current one.
 */
export function ArtistPlayControls({
  name,
  tracks,
  detail,
}: {
  name: string;
  tracks: TrackListItem[];
  detail?: string;
}) {
  const theme = useTheme();
  const play = usePlayTrack();
  const { toggle, toggleShuffle } = usePlayerControls();
  const current = useCurrentTrack();
  const { isPlaying, shuffle } = usePlayerPlayback();
  const { commandPending } = useRemotePlayback();
  const { playingHere, showPause, canPlay } = listPlaybackState(
    tracks,
    current,
    isPlaying,
  );

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.space.md,
        paddingHorizontal: theme.space.lg,
      }}
    >
      <Text
        numberOfLines={2}
        style={{
          flex: 1,
          color: theme.color.fgMuted,
          fontSize: 13,
          fontVariant: ["tabular-nums"],
        }}
      >
        {detail}
      </Text>
      <Pressable
        onPress={() => {
          void Haptics.selectionAsync();
          toggleShuffle();
        }}
        disabled={commandPending}
        accessibilityRole="switch"
        accessibilityLabel="Shuffle"
        accessibilityState={{ checked: shuffle, disabled: commandPending }}
        hitSlop={4}
        style={({ pressed }) => ({
          width: SHUFFLE_SIZE,
          height: SHUFFLE_SIZE,
          alignItems: "center",
          justifyContent: "center",
          opacity: commandPending ? 0.4 : pressed ? 0.6 : 1,
        })}
      >
        <SymbolView
          name="shuffle"
          size={22}
          weight="semibold"
          tintColor={shuffle ? theme.color.accent : theme.color.fgMuted}
        />
        {/* The dot marks "on" without relying on colour alone. */}
        {shuffle ? (
          <View
            style={{
              position: "absolute",
              bottom: 4,
              width: 4,
              height: 4,
              borderRadius: 2,
              backgroundColor: theme.color.accent,
            }}
          />
        ) : null}
      </Pressable>
      <Pressable
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          if (playingHere) toggle();
          else startListPlayback(play, listPlaybackQueue(tracks), shuffle);
        }}
        disabled={!canPlay}
        accessibilityRole="button"
        accessibilityLabel={showPause ? `Pause ${name}` : `Play ${name}`}
        accessibilityState={{ disabled: !canPlay }}
        style={({ pressed }) => ({
          width: PLAY_SIZE,
          height: PLAY_SIZE,
          borderRadius: PLAY_SIZE / 2,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.color.accent,
          opacity: !canPlay ? 0.5 : pressed ? 0.85 : 1,
          transform: [{ scale: pressed ? 0.96 : 1 }],
        })}
      >
        <SymbolView
          name={showPause ? "pause.fill" : "play.fill"}
          size={22}
          tintColor={theme.color.onAccent}
        />
      </Pressable>
    </View>
  );
}
