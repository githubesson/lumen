import { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import {
  api,
  useAuth,
  type ReplayData,
  type TrackListItem,
} from "@music-library/core";
import { EmptyState } from "../../../components/empty-state";
import {
  useBottomDockInset,
  useDockScrollHandler,
} from "../../../components/dock/dock-context";
import { BrowseLinksCard } from "../../../components/library/browse-links-card";
import { HomeHeaderCapsule } from "../../../components/library/home-header-capsule";
import { HorizontalShelf } from "../../../components/horizontal-shelf";
import { Section } from "../../../components/section";
import { RankedTrackRow } from "../../../components/library/ranked-track-row";
import { ResumeCard } from "../../../components/library/resume-card";
import { AlbumTile, TrackTile } from "../../../components/library/shelf-tiles";
import { WelcomeCard } from "../../../components/library/welcome-card";
import { usePlayTrack } from "../../../context/player";
import { qk } from "../../../lib/query-keys";
import { usePlayQueue } from "../../../lib/use-play-queue";
import { useTheme } from "../../../theme/theme";

const REDISCOVER_COUNT = 10;

// ── Small deterministic helpers ─────────────────────────────────────────────
// The home page reshuffles once per day, not once per render, so it feels
// curated rather than jittery. Everything seeds off the local date.

function daySeed(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function hashString(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++)
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
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
  if (h < 5) return "Up late?";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function last30Range(): { from: string; to: string; bucket: "day" } {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString(), bucket: "day" };
}

// ── Screen ──────────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const theme = useTheme();
  const router = useRouter();
  const dockInset = useBottomDockInset();
  const dockScroll = useDockScrollHandler();
  const { me } = useAuth();
  const userId = me?.id;
  const play = usePlayTrack();
  // Greeting is fixed for the lifetime of the screen so the large title
  // doesn't flip mid-session while the user is looking at it.
  const [greeting] = useState(greetingForNow);
  const [seed] = useState(daySeed);

  const recentQuery = useQuery({
    queryKey: qk.recent(userId),
    // Same limit as the Favorites tab's "Recent" mode so both screens share
    // one cache entry instead of clobbering each other.
    queryFn: ({ signal }) => api.listRecent(100, { signal }),
    enabled: !!userId,
  });

  const favoritesQuery = useQuery({
    queryKey: qk.favorites(userId),
    queryFn: ({ signal }) => api.listFavorites({ signal }),
    enabled: !!userId,
  });

  const replayQuery = useQuery<ReplayData>({
    queryKey: qk.replay("last-30"),
    queryFn: ({ signal }) => api.getReplay(last30Range(), { signal }),
  });

  const rediscoverQuery = useQuery({
    queryKey: qk.homeRediscover(seed),
    queryFn: async ({ signal }) => {
      const probe = await api.listAlbumsPage({
        q: "",
        limit: 1,
        offset: 0,
        signal,
      });
      const total = probe.total;
      if (total === 0) return { items: [], total: 0 };
      const maxOffset = Math.max(0, total - REDISCOVER_COUNT);
      const offset = maxOffset > 0 ? hashString(seed) % (maxOffset + 1) : 0;
      const page = await api.listAlbumsPage({
        q: "",
        limit: REDISCOVER_COUNT,
        offset,
        signal,
      });
      return { items: page.items, total };
    },
  });

  // Recents come back as a raw play log; collapse repeats so the shelf is a
  // run of distinct tracks rather than the same song five times.
  const recents = useMemo<TrackListItem[]>(() => {
    const seen = new Set<string>();
    const out: TrackListItem[] = [];
    for (const t of recentQuery.data ?? []) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
      if (out.length >= 13) break;
    }
    return out;
  }, [recentQuery.data]);

  const lastPlayed = recents[0];
  const recentShelf = useMemo(() => recents.slice(1), [recents]);

  const replay = replayQuery.data;
  const hasReplay = !!replay && replay.summary.total_plays > 0;
  const topTracks = useMemo<TrackListItem[]>(
    () => ((replay?.top_tracks ?? []) as TrackListItem[]).slice(0, 5),
    [replay?.top_tracks],
  );
  const topTrackPlays = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of replay?.top_tracks ?? []) m.set(t.id, t.plays);
    return m;
  }, [replay?.top_tracks]);
  const topAlbums = useMemo(
    () => (replay?.top_albums ?? []).slice(0, 10),
    [replay?.top_albums],
  );

  const favorites = useMemo<TrackListItem[]>(
    () => favoritesQuery.data ?? [],
    [favoritesQuery.data],
  );
  const favoritesShelf = useMemo(
    () => seededShuffle(favorites, seed).slice(0, 12),
    [favorites, seed],
  );

  const onRecentPress = usePlayQueue(recents);
  const onTopTrackPress = usePlayQueue(topTracks);
  const onFavoriteTilePress = usePlayQueue(favoritesShelf);

  const onShuffleFavorites = useCallback(() => {
    if (favorites.length === 0) return;
    void Haptics.selectionAsync();
    const shuffled = seededShuffle(favorites, `${Date.now()}`);
    play(shuffled[0], shuffled);
  }, [favorites, play]);

  const onAlbumPress = useCallback(
    (id: string) => {
      void Haptics.selectionAsync();
      router.push({
        pathname: "/(tabs)/(library)/albums/[id]",
        params: { id },
      });
    },
    [router],
  );

  const goBrowse = useCallback(
    (mode: "tracks" | "albums" | "artists") => {
      void Haptics.selectionAsync();
      router.push({
        pathname: "/(tabs)/(library)/browse",
        params: { mode },
      });
    },
    [router],
  );

  const onSearchPress = useCallback(() => {
    void Haptics.selectionAsync();
    router.push({
      pathname: "/(tabs)/(library)/browse",
      params: { focusSearch: "1" },
    });
  }, [router]);

  const onUploadPress = useCallback(() => {
    void Haptics.selectionAsync();
    router.push("/(tabs)/(library)/upload");
  }, [router]);

  const onRefresh = useCallback(() => {
    void recentQuery.refetch();
    void favoritesQuery.refetch();
    void replayQuery.refetch();
    void rediscoverQuery.refetch();
  }, [recentQuery, favoritesQuery, replayQuery, rediscoverQuery]);

  const isInitialLoading =
    (recentQuery.isLoading || !userId) &&
    replayQuery.isLoading &&
    rediscoverQuery.isLoading;
  const refreshing =
    recentQuery.isRefetching ||
    favoritesQuery.isRefetching ||
    replayQuery.isRefetching;

  // A brand-new account has nothing personal to show yet: no plays, no
  // favorites. Welcome them in instead of rendering a page of empty shelves.
  const isNewHere =
    !recentQuery.isLoading &&
    !replayQuery.isLoading &&
    !favoritesQuery.isLoading &&
    recents.length === 0 &&
    !hasReplay &&
    favorites.length === 0;

  return (
    <>
      <Stack.Screen
        options={{
          title: greeting,
          headerRight: () => (
            <HomeHeaderCapsule
              onSearchPress={onSearchPress}
              onUploadPress={onUploadPress}
            />
          ),
        }}
      />
      <ScrollView
        {...dockScroll}
        style={{ flex: 1, backgroundColor: theme.color.bg }}
        contentInsetAdjustmentBehavior="automatic"
        scrollIndicatorInsets={{ bottom: dockInset }}
        contentContainerStyle={{
          paddingTop: theme.space.sm,
          paddingBottom: dockInset + theme.space.xl,
          gap: theme.space.xl,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.color.fgMuted}
          />
        }
      >
        {isInitialLoading ? (
          <EmptyState loading />
        ) : (
          <>
            {isNewHere && (
              <WelcomeCard
                onBrowse={() => goBrowse("tracks")}
                onUpload={onUploadPress}
                style={{ marginHorizontal: theme.space.lg }}
              />
            )}

            {lastPlayed && (
              <View style={{ gap: theme.space.lg }}>
                <ResumeCard
                  track={lastPlayed}
                  onPress={onRecentPress}
                  style={{ marginHorizontal: theme.space.lg }}
                />
                {recentShelf.length > 0 && (
                  <HorizontalShelf>
                    {recentShelf.map((t) => (
                      <TrackTile key={t.id} track={t} onPress={onRecentPress} />
                    ))}
                  </HorizontalShelf>
                )}
              </View>
            )}

            {hasReplay && topTracks.length > 0 && (
              <Section
                eyebrow="Last 30 days"
                title="On repeat"
                actionLabel="See all"
                onAction={() => {
                  void Haptics.selectionAsync();
                  router.push("/(tabs)/(settings)/replay");
                }}
              >
                <View>
                  {topTracks.map((t, i) => (
                    <RankedTrackRow
                      key={t.id}
                      rank={i + 1}
                      track={t}
                      plays={topTrackPlays.get(t.id) ?? 0}
                      onPress={onTopTrackPress}
                    />
                  ))}
                </View>
              </Section>
            )}

            {hasReplay && topAlbums.length > 0 && (
              <Section eyebrow="Heavy rotation" title="Your albums">
                <HorizontalShelf>
                  {topAlbums.map((a) => (
                    <AlbumTile
                      key={a.id}
                      id={a.id}
                      title={a.title}
                      subtitle={a.artist}
                      onPress={onAlbumPress}
                    />
                  ))}
                </HorizontalShelf>
              </Section>
            )}

            {favoritesShelf.length > 0 && (
              <Section
                eyebrow="From your favorites"
                title="Loved by you"
                actionLabel="Shuffle"
                actionIcon="shuffle"
                onAction={onShuffleFavorites}
              >
                <HorizontalShelf>
                  {favoritesShelf.map((t) => (
                    <TrackTile
                      key={t.id}
                      track={t}
                      onPress={onFavoriteTilePress}
                    />
                  ))}
                </HorizontalShelf>
              </Section>
            )}

            {(rediscoverQuery.data?.items.length ?? 0) > 0 && (
              <Section
                eyebrow="A daily dig through the shelves"
                title="Rediscover"
              >
                <HorizontalShelf>
                  {rediscoverQuery.data!.items.map((a) => (
                    <AlbumTile
                      key={a.id}
                      id={a.id}
                      title={a.title}
                      subtitle={a.artist_name ?? undefined}
                      onPress={onAlbumPress}
                    />
                  ))}
                </HorizontalShelf>
              </Section>
            )}

            <Section title="Your library">
              <BrowseLinksCard
                onBrowse={goBrowse}
                style={{ marginHorizontal: theme.space.lg }}
              />
            </Section>
          </>
        )}
      </ScrollView>
    </>
  );
}
