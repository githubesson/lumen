import { useEffect, useMemo, useRef } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { api, type TrackListItem } from '@music-library/core';
import { AppText, Spinner } from '../primitives';
import { activeLyricIndex, parseLrc } from '../../lib/lyrics';
import { usePlayerTime } from '../../context/player';
import { useTheme } from '../../theme/theme';

const LINE_HEIGHT = 34;

/**
 * Lyrics for the current track, scrolling in time when the provider returns
 * synced (LRC) lyrics and falling back to plain text when it does not.
 */
export function LyricsPane({ track }: { track: TrackListItem }) {
  const t = useTheme();
  const { currentTime } = usePlayerTime();
  const scrollRef = useRef<ScrollView>(null);

  const lyrics = useQuery({
    queryKey: ['lyrics', track.id],
    queryFn: ({ signal }) =>
      api.getLyrics(
        {
          track_name: track.title,
          artist_name: track.artist ?? undefined,
          album_name: track.album_title ?? undefined,
          duration: track.duration_ms > 0 ? track.duration_ms / 1000 : undefined,
        },
        { signal },
      ),
    // Lyrics never change for a track, and a miss is as stable as a hit.
    staleTime: Infinity,
    retry: false,
  });

  const synced = useMemo(
    () => (lyrics.data?.syncedLyrics ? parseLrc(lyrics.data.syncedLyrics) : []),
    [lyrics.data?.syncedLyrics],
  );

  const activeIndex = synced.length > 0 ? activeLyricIndex(synced, currentTime) : -1;

  // Keep the current line roughly a third down the pane rather than at the top,
  // so the next few lines are always readable.
  useEffect(() => {
    if (activeIndex < 0) return;
    scrollRef.current?.scrollTo({
      y: Math.max(0, activeIndex * LINE_HEIGHT - 120),
      animated: true,
    });
  }, [activeIndex]);

  if (lyrics.isLoading) return <Spinner />;

  const plain = lyrics.data?.plainLyrics?.trim();

  if (lyrics.isError || (!plain && synced.length === 0)) {
    return (
      <View style={styles.empty}>
        <AppText variant="heading" muted>
          No Lyrics Available
        </AppText>
        <AppText variant="body" muted style={styles.centered}>
          There aren’t any lyrics available for this song.
        </AppText>
      </View>
    );
  }

  if (plain?.toLowerCase() === 'instrumental' && synced.length === 0) {
    return (
      <View style={styles.empty}>
        <AppText variant="heading" muted>
          Instrumental
        </AppText>
      </View>
    );
  }

  if (synced.length === 0) {
    return (
      <ScrollView contentContainerStyle={styles.content}>
        <AppText variant="heading" style={styles.plain}>
          {plain}
        </AppText>
      </ScrollView>
    );
  }

  return (
    <ScrollView ref={scrollRef} contentContainerStyle={styles.content}>
      {synced.map((line, index) => (
        <View key={`${line.time}-${index}`} style={styles.line}>
          <AppText
            variant="heading"
            style={[
              styles.lineText,
              {
                color: index === activeIndex ? t.color.fg : t.color.fgMuted,
                opacity: index === activeIndex ? 1 : 0.55,
              },
            ]}>
            {line.text}
          </AppText>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
  centered: { textAlign: 'center' },
  content: { paddingVertical: 40, paddingHorizontal: 24, gap: 2 },
  line: { minHeight: LINE_HEIGHT, justifyContent: 'center' },
  lineText: { fontSize: 19, fontWeight: '600' },
  plain: { fontSize: 15, fontWeight: '400', lineHeight: 26 },
});
