import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  pluralize,
  trackCoverUrl,
  useAuth,
  type ReplayData,
  type TrackListItem,
} from '@music-library/core';
import { HEADER_HEIGHT, Screen } from '../components/screen';
import { DOCK_CLEARANCE } from '../components/track-list';
import { Section } from '../components/section';
import { AlbumTile, HorizontalShelf, TrackTile } from '../components/shelf';
import { CoverArt } from '../components/cover-art';
import { AppText, Button, EmptyState } from '../components/primitives';
import { SkeletonBlock, SkeletonGroup } from '../components/skeleton';
import { useHover } from '../components/hoverable';
import { SFSymbol } from '../native/sf-symbol';
import { usePlayTrack } from '../context/player';
import { useNavigation } from '../navigation/navigation';
import { qk } from '../lib/query-keys';
import { QUERY_STALE_TIME } from '../lib/query-policy';
import { useTheme } from '../theme/theme';

const REDISCOVER_COUNT = 12;
const RECENT_SHELF_COUNT = 13;
const TOP_TRACK_COUNT = 5;

// ── Deterministic helpers ───────────────────────────────────────────────────
// The page reshuffles once a day, not once a render, so it reads as curated
// rather than jittery. Everything seeds off the local date. Mirrors the iOS
// client's home screen (`mobile/app/(tabs)/(library)/index.tsx`).

function daySeed(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function hashString(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const rand = mulberry32(hashString(seed));
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function greetingForNow(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Up late?';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function last30Range(): { from: string; to: string; bucket: 'day' } {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString(), bucket: 'day' };
}

// ── Screen ──────────────────────────────────────────────────────────────────

export function HomeScreen() {
  const t = useTheme();
  const { me } = useAuth();
  const play = usePlayTrack();
  const { selectSection, push } = useNavigation();
  // Both fixed for the life of the screen, so the greeting doesn't flip and
  // the shelves don't reshuffle while the user is looking at them.
  const [greeting] = useState(greetingForNow);
  const [seed] = useState(daySeed);

  const recentQuery = useQuery({
    queryKey: qk.recent(me?.id),
    queryFn: ({ signal }) => api.listRecent(100, { signal }),
    staleTime: QUERY_STALE_TIME.default,
  });

  const favoritesQuery = useQuery({
    queryKey: qk.favorites(me?.id),
    queryFn: ({ signal }) => api.listFavorites({ signal }),
    staleTime: QUERY_STALE_TIME.default,
  });

  const replayQuery = useQuery<ReplayData>({
    queryKey: qk.replay(me?.id, 'last-30'),
    queryFn: ({ signal }) => api.getReplay(last30Range(), { signal }),
    staleTime: QUERY_STALE_TIME.default,
  });

  const rediscoverQuery = useQuery({
    queryKey: qk.homeRediscover(me?.id, seed),
    staleTime: QUERY_STALE_TIME.rediscover,
    queryFn: async ({ signal }) => {
      // One probe for the total, then a page from a seeded offset — the server
      // has no "random albums" endpoint, and pulling the whole library down to
      // pick twelve of them would be absurd.
      const probe = await api.listAlbumsPage({ limit: 1, offset: 0, signal });
      if (probe.total === 0) return { items: [], total: 0 };
      const maxOffset = Math.max(0, probe.total - REDISCOVER_COUNT);
      const offset = maxOffset > 0 ? hashString(seed) % (maxOffset + 1) : 0;
      const page = await api.listAlbumsPage({
        limit: REDISCOVER_COUNT,
        offset,
        signal,
      });
      return { items: page.items, total: probe.total };
    },
  });

  // Recents come back as a raw play log; collapse repeats so the shelf is a run
  // of distinct tracks rather than the same song five times.
  const recents = useMemo<TrackListItem[]>(() => {
    const seen = new Set<string>();
    const out: TrackListItem[] = [];
    for (const track of recentQuery.data ?? []) {
      if (seen.has(track.id)) continue;
      seen.add(track.id);
      out.push(track);
      if (out.length >= RECENT_SHELF_COUNT) break;
    }
    return out;
  }, [recentQuery.data]);

  const lastPlayed = recents[0];
  const recentShelf = useMemo(() => recents.slice(1), [recents]);

  const replay = replayQuery.data;
  const hasReplay = Boolean(replay && replay.summary.total_plays > 0);
  const topTracks = useMemo<TrackListItem[]>(
    () => ((replay?.top_tracks ?? []) as TrackListItem[]).slice(0, TOP_TRACK_COUNT),
    [replay?.top_tracks],
  );
  const topTrackPlays = useMemo(() => {
    const plays = new Map<string, number>();
    for (const track of replay?.top_tracks ?? []) plays.set(track.id, track.plays);
    return plays;
  }, [replay?.top_tracks]);
  const topAlbums = useMemo(
    () => (replay?.top_albums ?? []).slice(0, 10),
    [replay?.top_albums],
  );

  const favorites = useMemo(() => favoritesQuery.data ?? [], [favoritesQuery.data]);
  const favoritesShelf = useMemo(
    () => seededShuffle(favorites, seed).slice(0, 12),
    [favorites, seed],
  );

  const playFrom = useCallback(
    (queue: TrackListItem[]) => (track: TrackListItem) => play(track, queue),
    [play],
  );

  const shuffleFavorites = useCallback(() => {
    if (favorites.length === 0) return;
    const shuffled = seededShuffle(favorites, `${Date.now()}`);
    play(shuffled[0], shuffled);
  }, [favorites, play]);

  const openAlbum = useCallback(
    (id: string) => push({ screen: 'album', id }),
    [push],
  );

  const isInitialLoading =
    recentQuery.isLoading && replayQuery.isLoading && rediscoverQuery.isLoading;

  // A brand-new account has nothing personal to show. Welcome them in rather
  // than rendering a page of empty shelves.
  const isNewHere =
    !recentQuery.isLoading &&
    !replayQuery.isLoading &&
    !favoritesQuery.isLoading &&
    recents.length === 0 &&
    !hasReplay &&
    favorites.length === 0;

  return (
    <Screen title={me ? `${greeting}, ${me.username}` : greeting}>
      {isInitialLoading ? (
        <HomeSkeleton />
      ) : (
        <ScrollView
          contentContainerStyle={{
            paddingTop: HEADER_HEIGHT + t.space.sm,
            paddingBottom: DOCK_CLEARANCE,
            gap: t.space.xl,
          }}>
          {isNewHere ? (
            <EmptyState
              title="Nothing here yet"
              detail="Browse the library and play something — this page fills itself in as you listen."
            />
          ) : null}

          {lastPlayed ? (
            <View style={{ gap: t.space.lg }}>
              <ResumeCard track={lastPlayed} onPlay={playFrom(recents)} />
              {recentShelf.length > 0 ? (
                <HorizontalShelf>
                  {recentShelf.map(track => (
                    <TrackTile
                      key={track.id}
                      track={track}
                      onPress={playFrom(recents)}
                    />
                  ))}
                </HorizontalShelf>
              ) : null}
            </View>
          ) : null}

          {hasReplay && topTracks.length > 0 ? (
            <Section eyebrow="Last 30 days" title="On repeat">
              <View style={{ paddingHorizontal: t.space.xl }}>
                {topTracks.map((track, i) => (
                  <RankedTrackRow
                    key={track.id}
                    rank={i + 1}
                    track={track}
                    plays={topTrackPlays.get(track.id) ?? 0}
                    onPress={playFrom(topTracks)}
                  />
                ))}
              </View>
            </Section>
          ) : null}

          {hasReplay && topAlbums.length > 0 ? (
            <Section eyebrow="Heavy rotation" title="Your albums">
              <HorizontalShelf>
                {topAlbums.map(album => (
                  <AlbumTile
                    key={album.id}
                    id={album.id}
                    title={album.title}
                    subtitle={album.artist}
                    onPress={openAlbum}
                  />
                ))}
              </HorizontalShelf>
            </Section>
          ) : null}

          {favoritesShelf.length > 0 ? (
            <Section
              eyebrow="From your favorites"
              title="Loved by you"
              actionLabel="Shuffle"
              actionSymbol="shuffle"
              onAction={shuffleFavorites}>
              <HorizontalShelf>
                {favoritesShelf.map(track => (
                  <TrackTile
                    key={track.id}
                    track={track}
                    onPress={playFrom(favoritesShelf)}
                  />
                ))}
              </HorizontalShelf>
            </Section>
          ) : null}

          {(rediscoverQuery.data?.items.length ?? 0) > 0 ? (
            <Section eyebrow="A daily dig through the shelves" title="Rediscover">
              <HorizontalShelf>
                {rediscoverQuery.data!.items.map(album => (
                  <AlbumTile
                    key={album.id}
                    id={album.id}
                    title={album.title}
                    subtitle={album.artist_name ?? undefined}
                    onPress={openAlbum}
                  />
                ))}
              </HorizontalShelf>
            </Section>
          ) : null}

          <Section title="Your library">
            <View style={[styles.links, { paddingHorizontal: t.space.xl }]}>
              <Button
                title="Browse"
                symbol="magnifyingglass"
                onPress={() => selectSection('browse')}
              />
              <Button
                title="Favorites"
                symbol="heart"
                onPress={() => selectSection('favorites')}
              />
              <Button
                title="Playlists"
                symbol="music.note.list"
                onPress={() => selectSection('playlists')}
              />
            </View>
          </Section>
        </ScrollView>
      )}
    </Screen>
  );
}

/** Home-shaped placeholder: resume card, a shelf of tiles, ranked rows. */
function HomeSkeleton() {
  const t = useTheme();
  return (
    <SkeletonGroup
      style={{
        paddingTop: HEADER_HEIGHT + t.space.sm,
        paddingHorizontal: t.space.xl,
        gap: t.space.xl,
      }}>
      <SkeletonBlock width="100%" height={104} radius={t.radius.lg} />
      <View style={{ flexDirection: 'row', gap: t.space.lg }}>
        {Array.from({ length: 6 }, (_, index) => (
          <View key={index} style={{ gap: t.space.sm }}>
            <SkeletonBlock width={140} height={140} radius={t.radius.sm} />
            <SkeletonBlock width={98} height={10} />
            <SkeletonBlock width={63} height={9} />
          </View>
        ))}
      </View>
      <View style={{ gap: t.space.lg }}>
        {Array.from({ length: 4 }, (_, index) => (
          <View
            key={index}
            style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
            <SkeletonBlock width={34} height={34} radius={6} />
            <View style={{ flex: 1, gap: t.space.xs }}>
              <SkeletonBlock width="38%" height={11} />
              <SkeletonBlock width="22%" height={9} />
            </View>
          </View>
        ))}
      </View>
    </SkeletonGroup>
  );
}

/** The last thing played, offered back as one large target. */
function ResumeCard({
  track,
  onPlay,
}: {
  track: TrackListItem;
  onPlay: (track: TrackListItem) => void;
}) {
  const t = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      onPress={() => onPlay(track)}
      style={[
        styles.resume,
        {
          marginHorizontal: t.space.xl,
          padding: t.space.md,
          gap: t.space.md,
          borderRadius: t.radius.lg,
          borderColor: t.color.separator,
          backgroundColor: hovered ? t.color.selected : t.color.hover,
        },
      ]}
      {...hoverProps}>
      <CoverArt url={trackCoverUrl(track, 256)} size={72} radius={t.radius.md} />
      <View style={styles.resumeText}>
        <AppText variant="caption" muted>
          PICK UP WHERE YOU LEFT OFF
        </AppText>
        <AppText variant="heading" numberOfLines={1}>
          {track.title}
        </AppText>
        <AppText variant="caption" muted numberOfLines={1}>
          {[track.artist ?? 'Unknown artist', track.album_title]
            .filter(Boolean)
            .join(' — ')}
        </AppText>
      </View>
      <View style={[styles.resumePlay, { backgroundColor: t.color.accent }]}>
        <SFSymbol name="play.fill" size={15} color={t.color.onAccent} />
      </View>
    </Pressable>
  );
}

function RankedTrackRow({
  rank,
  track,
  plays,
  onPress,
}: {
  rank: number;
  track: TrackListItem;
  plays: number;
  onPress: (track: TrackListItem) => void;
}) {
  const t = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      onPress={() => onPress(track)}
      style={[
        styles.ranked,
        {
          height: 48,
          paddingHorizontal: t.space.sm,
          gap: t.space.md,
          borderRadius: t.radius.md,
          backgroundColor: hovered ? t.color.hover : 'transparent',
        },
      ]}
      {...hoverProps}>
      <AppText variant="heading" muted style={styles.rank}>
        {rank}
      </AppText>
      <CoverArt url={trackCoverUrl(track, 96)} size={34} radius={6} />
      <View style={styles.rankedText}>
        <AppText variant="label" numberOfLines={1}>
          {track.title}
        </AppText>
        <AppText variant="caption" muted numberOfLines={1}>
          {track.artist ?? 'Unknown artist'}
        </AppText>
      </View>
      <AppText variant="caption" muted>
        {pluralize(plays, 'play')}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  links: { flexDirection: 'row', gap: 8 },
  resume: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  resumeText: { flex: 1, minWidth: 0, gap: 2 },
  resumePlay: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ranked: { flexDirection: 'row', alignItems: 'center' },
  rank: { width: 20, textAlign: 'center' },
  rankedText: { flex: 1, minWidth: 0, gap: 1 },
});
