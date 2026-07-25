import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { trackCoverUrl } from '@music-library/core';
import { GlassEffectView } from '../../native/glass-effect-view';
import { SFSymbol } from '../../native/sf-symbol';
import { CoverArt } from '../cover-art';
import { Slider } from '../slider';
import { AppText } from '../primitives';
import { useHover } from '../hoverable';
import {
  useCurrentTrack,
  useIsPlaying,
  usePlayerControls,
  usePlayerTime,
  useTransport,
} from '../../context/player';
import { useOverlay } from '../../shell/overlay-context';
import { useTheme } from '../../theme/theme';

// Tall enough that the progress hairline gets clear space under the content
// row instead of crowding the buttons and track titles.
const BAR_HEIGHT = 66;
const BAR_RADIUS = BAR_HEIGHT / 2;

const BAR_PADDING = 20;

function BarButton({
  symbol,
  size = 13,
  active = false,
  onPress,
}: {
  symbol: string;
  size?: number;
  active?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.barButton,
        {
          // An active toggle reads as a filled accent disc, the way the repeat
          // and shuffle states do in Music.
          backgroundColor: active
            ? t.color.accent
            : hovered
              ? t.color.hover
              : 'transparent',
        },
      ]}
      {...hoverProps}>
      <SFSymbol
        name={symbol}
        size={size}
        color={active ? t.color.onAccent : t.color.fg}
      />
    </Pressable>
  );
}

/**
 * The compact transport bar: a single glass capsule holding the transport on
 * the left, the current track in the middle, and secondary actions on the
 * right, with a hairline progress line along the bottom edge.
 *
 * The capsule's shape comes from the native glass alone — no React border, no
 * `overflow: 'hidden'`. Drawing a rounded border here as well produced a second
 * outline a few points off the glass's own, so the bar appeared to have a
 * duplicate shape behind it.
 */
export function FloatingDock() {
  const t = useTheme();
  const track = useCurrentTrack();
  const isPlaying = useIsPlaying();
  const controls = usePlayerControls();
  const { currentTime, duration } = usePlayerTime();
  const { shuffle, repeat, muted, volume } = useTransport();
  const { openNowPlaying, nowPlayingOpen, toggleQueue, toggleLyrics } = useOverlay();

  // The expanded player has its own transport, so the bar slides away rather
  // than sitting underneath it.
  const shown = Boolean(track) && !nowPlayingOpen;
  const [visible, setVisible] = useState(shown);
  const entrance = useRef(new Animated.Value(shown ? 1 : 0)).current;

  const setVolume = useCallback(
    (v: number) => {
      if (muted) controls.setMuted(false);
      controls.setVolume(v);
    },
    [controls, muted],
  );

  useEffect(() => {
    if (shown) setVisible(true);
    const animation = Animated.spring(entrance, {
      toValue: shown ? 1 : 0,
      useNativeDriver: false,
      damping: 20,
      stiffness: 200,
      mass: 0.8,
    });
    animation.start(({ finished }) => {
      if (finished && !shown) setVisible(false);
    });
    return () => animation.stop();
  }, [shown, entrance]);

  if (!visible || !track) return null;

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const translateY = entrance.interpolate({
    inputRange: [0, 1],
    outputRange: [96, 0],
  });
  const subtitle = [track.artist ?? 'Unknown artist', track.album_title]
    .filter(Boolean)
    .join(' — ');

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.layer, { opacity: entrance, transform: [{ translateY }] }]}>
      <View style={styles.bar}>
        {/* The glass is a childless backdrop behind ordinary React views rather
            than their container: laying content out inside the native view put
            the last child past its trailing padding and dropped the whole row
            below the capsule. */}
        <GlassEffectView
          variant="regular"
          cornerRadius={BAR_RADIUS}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />

        <View style={styles.barContent}>
        <View style={styles.transport}>
          <BarButton
            symbol="shuffle"
            active={shuffle}
            onPress={controls.toggleShuffle}
          />
          <BarButton symbol="backward.fill" onPress={controls.prev} />
          <BarButton
            symbol={isPlaying ? 'pause.fill' : 'play.fill'}
            size={17}
            onPress={controls.toggle}
          />
          <BarButton symbol="forward.fill" onPress={controls.next} />
          <BarButton
            symbol={repeat === 'one' ? 'repeat.1' : 'repeat'}
            active={repeat !== 'off'}
            onPress={controls.cycleRepeat}
          />
        </View>

        <Pressable onPress={openNowPlaying} style={styles.nowPlaying}>
          <CoverArt url={trackCoverUrl(track, 96)} size={36} radius={6} />
          <View style={styles.meta}>
            <AppText variant="label" numberOfLines={1}>
              {track.title}
            </AppText>
            <AppText variant="caption" muted numberOfLines={1}>
              {subtitle}
            </AppText>
          </View>
        </Pressable>

        <View style={styles.actions}>
          <BarButton symbol="quote.bubble" onPress={toggleLyrics} />
          <BarButton symbol="list.bullet" onPress={toggleQueue} />
          <BarButton
            symbol={muted || volume === 0 ? 'speaker.slash.fill' : 'speaker.wave.2.fill'}
            onPress={controls.toggleMute}
          />
          {/* Inside the capsule with a fixed width of its own: as a flexible
              child it was squeezed to nothing and its thumb sat outside the
              bar, which left the volume unadjustable from here. */}
          <View style={styles.volume}>
            <Slider
              value={muted ? 0 : volume}
              max={1}
              onSeeking={setVolume}
              onSeek={setVolume}
            />
          </View>
        </View>

          <View
            style={[styles.progressTrack, { backgroundColor: t.color.overlayMuted }]}
            pointerEvents="none">
            <View
              style={[
                styles.progressFill,
                { width: `${progress * 100}%`, backgroundColor: t.color.fgMuted },
              ]}
            />
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 24,
    paddingBottom: 18,
  },
  bar: {
    height: BAR_HEIGHT,
    // Wide enough for the transport, the track and the actions to sit at their
    // natural size, but capped so the bar stays a floating control rather than
    // growing into a full-width toolbar.
    width: '100%',
    maxWidth: 820,
  },
  barContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: BAR_PADDING,
    // Keeps the row centred in the space above the progress line rather than
    // over it.
    paddingBottom: 8,
  },
  transport: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  nowPlaying: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minWidth: 0,
  },
  meta: { flex: 1, minWidth: 0 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  volume: { width: 64, height: 18, justifyContent: 'center', marginLeft: 4 },
  progressTrack: {
    position: 'absolute',
    left: BAR_PADDING + 6,
    right: BAR_PADDING + 6,
    bottom: 11,
    height: 2,
    borderRadius: 1,
    overflow: 'hidden',
  },
  progressFill: { height: 2, borderRadius: 1 },
  barButton: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
