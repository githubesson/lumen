import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, FlatList, Image, Pressable, StyleSheet, View } from 'react-native';
import {
  formatDurationMs,
  trackCoverUrl,
  useFavorite,
  useFavoriteActions,
  type TrackListItem,
} from '@music-library/core';
import { VisualEffectView } from '../../native/visual-effect-view';
import { SFSymbol } from '../../native/sf-symbol';
import { CoverArt } from '../cover-art';
import { Slider } from '../slider';
import { AppText } from '../primitives';
import { useHover } from '../hoverable';
import { LyricsPane } from './lyrics-pane';
import {
  useCurrentTrack,
  useIsPlaying,
  usePlayerControls,
  usePlayerQueue,
  usePlayerTime,
  useTransport,
} from '../../context/player';
import { useOverlay } from '../../shell/overlay-context';
import { Shell } from '../../native/shell';
import { useTheme } from '../../theme/theme';

const QUEUE_ROW_HEIGHT = 44;

function RoundButton({
  symbol,
  size = 15,
  active = false,
  dimmed = false,
  onPress,
}: {
  symbol: string;
  size?: number;
  active?: boolean;
  dimmed?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.roundButton,
        {
          backgroundColor: active
            ? t.color.accent
            : hovered
              ? t.color.overlayMuted
              : 'transparent',
        },
      ]}
      {...hoverProps}>
      <SFSymbol
        name={symbol}
        size={size}
        color={active ? t.color.onAccent : t.color.fg}
        style={dimmed ? styles.dimmed : undefined}
      />
    </Pressable>
  );
}

/**
 * A round button that carries its own translucent backing — for controls that
 * float directly on the artwork wash with no capsule around them.
 */
function CircleButton({
  symbol,
  size = 13,
  onPress,
}: {
  symbol: string;
  size?: number;
  onPress: () => void;
}) {
  const t = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.circleButton,
        {
          backgroundColor: hovered ? t.color.overlayMuted : 'rgba(127,127,127,0.22)',
          borderColor: t.color.overlayMuted,
        },
      ]}
      {...hoverProps}>
      <SFSymbol name={symbol} size={size} color={t.color.fg} />
    </Pressable>
  );
}

function QueueRow({
  track,
  active,
  onPress,
}: {
  track: TrackListItem;
  active: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.queueRow,
        {
          borderRadius: t.radius.sm,
          backgroundColor: hovered ? t.color.overlayMuted : 'transparent',
        },
      ]}
      {...hoverProps}>
      <CoverArt url={trackCoverUrl(track, 64)} size={30} radius={4} />
      <View style={styles.grow}>
        <AppText
          variant="label"
          numberOfLines={1}
          style={active ? { color: t.color.accent } : undefined}>
          {track.title}
        </AppText>
        <AppText variant="caption" muted numberOfLines={1}>
          {track.artist ?? 'Unknown artist'}
        </AppText>
      </View>
    </Pressable>
  );
}

/**
 * The expanded player: artwork and transport on the left, lyrics or the queue
 * on the right, over a background derived from the current artwork.
 *
 * The background is the artwork itself, scaled to fill and covered by a
 * within-window vibrancy view — which blurs whatever is behind it, so the wash
 * follows the album's colours without needing any image processing.
 */
export function NowPlayingOverlay() {
  const t = useTheme();
  const track = useCurrentTrack();
  const isPlaying = useIsPlaying();
  const controls = usePlayerControls();
  const { currentTime, duration } = usePlayerTime();
  const { queue, index } = usePlayerQueue();
  const { volume, muted, shuffle, repeat } = useTransport();
  const { nowPlayingOpen, closeNowPlaying, paneMode, toggleLyrics, toggleQueue } =
    useOverlay();
  const isFavorite = useFavorite(track?.id ?? '');
  const { toggle: toggleFavorite } = useFavoriteActions();

  const onJump = useCallback((i: number) => controls.jumpTo(i), [controls]);

  const setVolume = useCallback(
    (v: number) => {
      if (muted) controls.setMuted(false);
      controls.setVolume(v);
    },
    [controls, muted],
  );

  // Kept mounted through the exit animation, then unmounted so its native glass
  // views and the lyrics query stop costing anything.
  const [visible, setVisible] = useState(nowPlayingOpen);
  const progress = useRef(new Animated.Value(nowPlayingOpen ? 1 : 0)).current;

  useEffect(() => {
    if (nowPlayingOpen) setVisible(true);
    // Short enough to read as a cut rather than a transition. Animations here
    // run on the JS thread (`useNativeDriver` is a no-op on react-native-macos),
    // so a longer one competes with mounting the panel's own contents and the
    // whole thing lands late.
    const animation = Animated.timing(progress, {
      toValue: nowPlayingOpen ? 1 : 0,
      duration: nowPlayingOpen ? 110 : 90,
      useNativeDriver: false,
    });
    animation.start(({ finished }) => {
      if (!finished) return;
      // The toolbar and sidebar are the window's, not React's, so the player
      // has to ask for them to be put away rather than drawing over them.
      //
      // Deliberately only after the animation has finished: collapsing the
      // sidebar resizes the content pane, which commits and lays out the
      // shadow tree from the main thread — and doing that while this JS-driven
      // animation was still committing frames from the JS thread was a data
      // race inside React Native that crashed the app (folly::dynamic clone
      // segfault under `setImmersive`). An interrupted animation skips it; the
      // replacement animation's completion applies the latest state.
      Shell.setImmersive(nowPlayingOpen);
      if (!nowPlayingOpen) setVisible(false);
    });
    return () => animation.stop();
  }, [nowPlayingOpen, progress]);

  if (!visible || !track) return null;

  const artworkUrl = trackCoverUrl(track, 600);
  const remaining = Math.max(0, duration - currentTime);
  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [8, 0],
  });

  return (
    <Animated.View
      style={[styles.root, { opacity: progress, transform: [{ translateY }] }]}>
      {/* Artwork wash: the image fills the pane and the vibrancy view above it
          blurs it in place. */}
      <Image source={{ uri: artworkUrl }} style={styles.backdropImage} blurRadius={0} />
      <VisualEffectView
        material="underWindowBackground"
        blendingMode="withinWindow"
        alwaysActive
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.scrim, { backgroundColor: t.color.bg }]} />

      <View style={styles.topBar}>
        {/* A plain translucent disc, not glass: an NSGlassEffectView wrapped
            around a control this small drew its own capsule inside the
            button's, so the close control read as a ring with an x in it. */}
        <CircleButton symbol="xmark" size={12} onPress={closeNowPlaying} />
      </View>

      <View style={styles.body}>
        <View style={styles.playerColumn}>
          <View style={styles.artworkWrap}>
            <CoverArt url={artworkUrl} size={300} radius={t.radius.md} />
          </View>

          <View style={styles.details}>
            <View style={styles.titleRow}>
              <View style={styles.grow}>
                <AppText variant="heading" numberOfLines={1} style={styles.title}>
                  {track.title}
                </AppText>
                <AppText muted numberOfLines={1}>
                  {[track.artist ?? 'Unknown artist', track.album_title]
                    .filter(Boolean)
                    .join(' — ')}
                </AppText>
              </View>
              <RoundButton
                symbol={isFavorite ? 'star.fill' : 'star'}
                size={13}
                onPress={() => void toggleFavorite(track.id)}
              />
            </View>

            <View style={styles.scrubber}>
              <Slider value={currentTime} max={duration} onSeek={controls.seek} />
              <View style={styles.times}>
                <AppText variant="caption" muted style={styles.mono}>
                  {formatDurationMs(currentTime * 1000)}
                </AppText>
                <AppText variant="caption" muted style={styles.mono}>
                  {`-${formatDurationMs(remaining * 1000)}`}
                </AppText>
              </View>
            </View>

            <View style={styles.transport}>
              <RoundButton
                symbol="shuffle"
                active={shuffle}
                onPress={controls.toggleShuffle}
              />
              <RoundButton symbol="backward.fill" size={18} onPress={controls.prev} />
              <RoundButton
                symbol={isPlaying ? 'pause.fill' : 'play.fill'}
                size={26}
                onPress={controls.toggle}
              />
              <RoundButton symbol="forward.fill" size={18} onPress={controls.next} />
              <RoundButton
                symbol={repeat === 'one' ? 'repeat.1' : 'repeat'}
                active={repeat !== 'off'}
                onPress={controls.cycleRepeat}
              />
            </View>
          </View>
        </View>

        <View style={styles.pane}>
          {paneMode === 'lyrics' ? (
            <LyricsPane track={track} />
          ) : (
            <FlatList
              data={queue}
              keyExtractor={(item, i) => `${item.id}-${i}`}
              getItemLayout={(_data, i) => ({
                length: QUEUE_ROW_HEIGHT,
                offset: QUEUE_ROW_HEIGHT * i,
                index: i,
              })}
              initialNumToRender={16}
              windowSize={5}
              contentContainerStyle={styles.queueContent}
              renderItem={({ item, index: i }) => (
                <QueueRow
                  track={item}
                  active={i === index}
                  onPress={() => onJump(i)}
                />
              )}
            />
          )}
        </View>
      </View>

      <View style={styles.bottomCluster}>
        <View style={styles.volumeCapsule}>
          <RoundButton
            symbol={muted || volume === 0 ? 'speaker.slash.fill' : 'speaker.wave.2.fill'}
            size={13}
            onPress={controls.toggleMute}
          />
          <View style={styles.volumeSlider}>
            <Slider
              value={muted ? 0 : volume}
              max={1}
              // Applied while dragging, not only on release: volume is the one
              // control you judge by ear as you move it.
              onSeeking={setVolume}
              onSeek={setVolume}
            />
          </View>
        </View>

        <View style={styles.toggleCapsule}>
          <RoundButton
            symbol="quote.bubble"
            size={13}
            active={paneMode === 'lyrics'}
            onPress={toggleLyrics}
          />
          <RoundButton
            symbol="list.bullet"
            size={13}
            active={paneMode === 'queue'}
            onPress={toggleQueue}
          />
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject },
  backdropImage: { ...StyleSheet.absoluteFillObject, resizeMode: 'cover' },
  // Tones the wash down so text stays legible over bright artwork.
  scrim: { ...StyleSheet.absoluteFillObject, opacity: 0.55 },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    // Clears the traffic lights, which stay visible once the toolbar is hidden.
    paddingLeft: 86,
    paddingRight: 16,
    paddingTop: 12,
  },
  circleButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  volumeCapsule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 30,
    width: 190,
    paddingLeft: 8,
    paddingRight: 14,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.16)',
    // A plain translucent pill rather than a glass view: nesting a slider
    // inside NSGlassEffectView left the whole capsule unrendered.
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  volumeSlider: { flex: 1, height: 18, justifyContent: 'center' },
  body: {
    flex: 1,
    flexDirection: 'row',
    paddingLeft: 96,
    paddingRight: 48,
    paddingBottom: 56,
  },
  playerColumn: {
    width: 360,
    justifyContent: 'center',
    gap: 28,
  },
  artworkWrap: { alignItems: 'center' },
  details: { gap: 14 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { fontSize: 17 },
  scrubber: { gap: 2 },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
  mono: { fontVariant: ['tabular-nums'] },
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pane: { flex: 1, minWidth: 260 },
  queueContent: { paddingVertical: 24, paddingHorizontal: 12 },
  queueRow: {
    height: QUEUE_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 8,
  },
  bottomCluster: {
    position: 'absolute',
    right: 16,
    bottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  toggleCapsule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: 30,
    paddingHorizontal: 6,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  grow: { flex: 1, minWidth: 0 },
  dimmed: { opacity: 0.6 },
  roundButton: {
    minWidth: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
});
