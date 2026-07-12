import { memo } from "react";
import {
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";
import {
  usePlayerControls,
  useCurrentTrack,
  usePlayerPlayback,
  usePlayerTime,
  usePlayerVolume,
} from "../../context/player";
import { ProgressScrubber } from "./progress-scrubber";
import { TransportControls } from "./transport-controls";
import { VolumeRow } from "./volume-row";
import {
  AirPlayButton,
  LyricsToggleButton,
  QueueToggleButton,
} from "./toolbar-buttons";
import { PlaybackDeviceButton } from "../playback-device-button";
import { TABLET_BREAKPOINT, TABLET_CONTENT_MAX_WIDTH } from "./constants";

/**
 * The pinned lower half of Now Playing: scrubber, transport, volume, and the
 * AirPlay/queue toolbar. Reads the player contexts itself and is memoized so
 * the 250ms time ticks re-render only this block, never the hero above it.
 */
export const NowPlayingBottomControls = memo(function NowPlayingBottomControls({
  queueOpen,
  lyricsOpen,
  onToggleQueueOpen,
  onToggleLyricsOpen,
  style,
}: {
  queueOpen: boolean;
  lyricsOpen: boolean;
  onToggleQueueOpen: () => void;
  onToggleLyricsOpen: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const controls = usePlayerControls();
  const current = useCurrentTrack();
  const { isPlaying, shuffle } = usePlayerPlayback();
  const { volume, muted } = usePlayerVolume();
  const time = usePlayerTime();
  const { width, height } = useWindowDimensions();
  const isTabletLayout = Math.min(width, height) >= TABLET_BREAKPOINT;

  const toggleQueue = () => {
    void Haptics.selectionAsync();
    onToggleQueueOpen();
  };
  const toggleLyrics = () => {
    void Haptics.selectionAsync();
    onToggleLyricsOpen();
  };

  return (
    <View style={style}>
      <ProgressScrubber
        trackKey={current?.id ?? null}
        time={time}
        isPlaying={isPlaying}
        onSeek={(seconds) => controls.seek(seconds)}
      />

      <TransportControls
        isPlaying={isPlaying}
        onPrev={() => controls.prev()}
        onToggle={() => controls.toggle()}
        onNext={() => controls.next()}
        style={isTabletLayout ? styles.transportTablet : styles.transport}
      />

      <VolumeRow
        value={muted ? 0 : volume}
        onSetVolume={(value) => controls.setVolume(value)}
        style={isTabletLayout ? styles.volumeRowTablet : styles.volumeRow}
      />

      {isTabletLayout ? (
        <View style={[styles.toolbar, styles.toolbarTablet]}>
          <AirPlayButton />
          <PlaybackDeviceButton glass />
          <LyricsToggleButton lyricsOpen={lyricsOpen} onPress={toggleLyrics} />
          <QueueToggleButton
            queueOpen={queueOpen}
            shuffle={shuffle}
            onPress={toggleQueue}
          />
        </View>
      ) : (
        <View style={styles.toolbar}>
          <AirPlayButton />
          <PlaybackDeviceButton glass />
          <LyricsToggleButton lyricsOpen={lyricsOpen} onPress={toggleLyrics} />
          <QueueToggleButton
            queueOpen={queueOpen}
            shuffle={shuffle}
            onPress={toggleQueue}
          />
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  transport: {
    marginTop: 40,
  },
  transportTablet: {
    justifyContent: "center",
    gap: 96,
    marginTop: 36,
  },
  volumeRow: {
    marginTop: 56,
  },
  volumeRowTablet: {
    marginTop: 52,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    alignSelf: "center",
    width: "88%",
    minWidth: 220,
    maxWidth: 340,
    marginTop: 44,
    paddingBottom: 4,
  },
  toolbarTablet: {
    alignSelf: "stretch",
    width: "100%",
    maxWidth: TABLET_CONTENT_MAX_WIDTH,
    marginTop: 38,
  },
});
