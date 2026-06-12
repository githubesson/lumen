import { useCallback, useMemo, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { Image } from "expo-image";
import {
  albumCoverUrl,
  api,
  useAuth,
  type ReplayData,
  type TrackListItem,
} from "@music-library/core";
import { AdaptiveGlass } from "../../../components/adaptive-glass";
import { CoverArt } from "../../../components/cover-art";
import { EmptyState } from "../../../components/empty-state";
import {
  useBottomDockInset,
  useDockScrollHandler,
} from "../../../components/dock/dock-context";
import { usePlayTrack } from "../../../context/player";
import { qk } from "../../../lib/query-keys";
import { usePlayQueue } from "../../../lib/use-play-queue";
import { useTheme, type ThemeTokens } from "../../../theme/theme";

const SHELF_TILE_SIZE = 124;
const HEADER_CAPSULE_HEIGHT = 44;
const HEADER_ACTION_WIDTH = 54;
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
              theme={theme}
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
                theme={theme}
                onBrowse={() => goBrowse("tracks")}
                onUpload={onUploadPress}
              />
            )}

            {lastPlayed && (
              <View style={{ gap: theme.space.lg }}>
                <ResumeCard
                  theme={theme}
                  track={lastPlayed}
                  onPress={onRecentPress}
                />
                {recentShelf.length > 0 && (
                  <HorizontalShelf>
                    {recentShelf.map((t) => (
                      <TrackTile
                        key={t.id}
                        theme={theme}
                        track={t}
                        onPress={onRecentPress}
                      />
                    ))}
                  </HorizontalShelf>
                )}
              </View>
            )}

            {hasReplay && topTracks.length > 0 && (
              <Section
                theme={theme}
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
                      theme={theme}
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
              <Section theme={theme} eyebrow="Heavy rotation" title="Your albums">
                <HorizontalShelf>
                  {topAlbums.map((a) => (
                    <AlbumTile
                      key={a.id}
                      theme={theme}
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
                theme={theme}
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
                      theme={theme}
                      track={t}
                      onPress={onFavoriteTilePress}
                    />
                  ))}
                </HorizontalShelf>
              </Section>
            )}

            {(rediscoverQuery.data?.items.length ?? 0) > 0 && (
              <Section
                theme={theme}
                eyebrow="A daily dig through the shelves"
                title="Rediscover"
              >
                <HorizontalShelf>
                  {rediscoverQuery.data!.items.map((a) => (
                    <AlbumTile
                      key={a.id}
                      theme={theme}
                      id={a.id}
                      title={a.title}
                      subtitle={a.artist_name ?? undefined}
                      onPress={onAlbumPress}
                    />
                  ))}
                </HorizontalShelf>
              </Section>
            )}

            <Section theme={theme} title="Your library">
              <View
                style={[
                  styles.card,
                  {
                    marginHorizontal: theme.space.lg,
                    backgroundColor: theme.color.bgElev1,
                    borderRadius: theme.radius.md,
                  },
                ]}
              >
                <BrowseLinkRow
                  theme={theme}
                  icon="music.note"
                  label="Songs"
                  onPress={() => goBrowse("tracks")}
                />
                <BrowseLinkRow
                  theme={theme}
                  icon="square.stack"
                  label="Albums"
                  divider
                  onPress={() => goBrowse("albums")}
                />
                <BrowseLinkRow
                  theme={theme}
                  icon="music.mic"
                  label="Artists"
                  divider
                  onPress={() => goBrowse("artists")}
                />
              </View>
            </Section>
          </>
        )}
      </ScrollView>
    </>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function Section({
  theme,
  eyebrow,
  title,
  actionLabel,
  actionIcon,
  onAction,
  children,
}: {
  theme: ThemeTokens;
  eyebrow?: string;
  title: string;
  actionLabel?: string;
  actionIcon?: SymbolViewProps["name"];
  onAction?: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={{ gap: theme.space.sm }}>
      <View
        style={{
          paddingHorizontal: theme.space.lg,
          flexDirection: "row",
          alignItems: "flex-end",
          justifyContent: "space-between",
        }}
      >
        <View style={{ gap: 2, flex: 1, minWidth: 0 }}>
          {eyebrow && (
            <Text
              style={{
                color: theme.color.fgMuted,
                fontSize: 11,
                letterSpacing: 0.6,
                textTransform: "uppercase",
              }}
            >
              {eyebrow}
            </Text>
          )}
          <Text
            style={{
              color: theme.color.fg,
              fontSize: 20,
              fontWeight: "600",
              letterSpacing: -0.2,
            }}
          >
            {title}
          </Text>
        </View>
        {actionLabel && onAction && (
          <Pressable
            onPress={onAction}
            accessibilityRole="button"
            accessibilityLabel={actionLabel}
            hitSlop={8}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              paddingBottom: 2,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            {actionIcon && (
              <SymbolView
                name={actionIcon}
                size={13}
                weight="semibold"
                tintColor={theme.color.accent}
              />
            )}
            <Text
              style={{
                color: theme.color.accent,
                fontSize: 14,
                fontWeight: "500",
              }}
            >
              {actionLabel}
            </Text>
          </Pressable>
        )}
      </View>
      {children}
    </View>
  );
}

function HorizontalShelf({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
    >
      {children}
    </ScrollView>
  );
}

/**
 * Big "pick up where you left off" card for the most recent play. Liquid
 * Glass surface with the artwork flush to the card's left edge so it lines up
 * exactly with the shelf tiles below.
 */
function ResumeCard({
  theme,
  track,
  onPress,
}: {
  theme: ThemeTokens;
  track: TrackListItem;
  onPress: (t: TrackListItem) => void;
}) {
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress(track);
      }}
      accessibilityRole="button"
      accessibilityLabel={`Resume ${track.title}${track.artist ? ` by ${track.artist}` : ""}`}
      style={({ pressed }) => ({
        marginHorizontal: theme.space.lg,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <AdaptiveGlass
        interactive
        style={{
          borderRadius: theme.radius.lg,
          borderCurve: "continuous",
          overflow: "hidden",
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: theme.space.md,
          }}
        >
          <CoverArt track={track} size={84} priority="high" radius={0} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text
              style={{
                color: theme.color.fgMuted,
                fontSize: 11,
                letterSpacing: 0.6,
                textTransform: "uppercase",
              }}
            >
              Jump back in
            </Text>
            <Text
              numberOfLines={1}
              style={{ color: theme.color.fg, fontSize: 17, fontWeight: "600" }}
            >
              {track.title}
            </Text>
            {track.artist ? (
              <Text
                numberOfLines={1}
                style={{ color: theme.color.fgMuted, fontSize: 14 }}
              >
                {track.artist}
              </Text>
            ) : null}
          </View>
          <SymbolView
            name="play.circle.fill"
            size={36}
            tintColor={theme.color.accent}
            style={{ marginRight: theme.space.md }}
          />
        </View>
      </AdaptiveGlass>
    </Pressable>
  );
}

function TrackTile({
  theme,
  track,
  onPress,
}: {
  theme: ThemeTokens;
  track: TrackListItem;
  onPress: (t: TrackListItem) => void;
}) {
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress(track);
      }}
      accessibilityRole="button"
      accessibilityLabel={
        track.artist ? `${track.title} by ${track.artist}` : track.title
      }
      style={({ pressed }) => ({
        width: SHELF_TILE_SIZE,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <CoverArt track={track} size={SHELF_TILE_SIZE} priority="low" />
      <Text
        numberOfLines={1}
        style={{
          color: theme.color.fg,
          fontSize: 14,
          fontWeight: "500",
          marginTop: 8,
        }}
      >
        {track.title}
      </Text>
      {track.artist ? (
        <Text
          numberOfLines={1}
          style={{ color: theme.color.fgMuted, fontSize: 12 }}
        >
          {track.artist}
        </Text>
      ) : null}
    </Pressable>
  );
}

function AlbumTile({
  theme,
  id,
  title,
  subtitle,
  onPress,
}: {
  theme: ThemeTokens;
  id: string;
  title: string;
  subtitle?: string;
  onPress: (id: string) => void;
}) {
  return (
    <Pressable
      onPress={() => onPress(id)}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title} by ${subtitle}` : title}
      style={({ pressed }) => ({
        width: SHELF_TILE_SIZE,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          width: SHELF_TILE_SIZE,
          height: SHELF_TILE_SIZE,
          borderRadius: theme.radius.sm,
          borderCurve: "continuous",
          overflow: "hidden",
          backgroundColor: theme.color.bgElev2,
        }}
      >
        <Image
          source={{ uri: albumCoverUrl(id, 256) }}
          style={{ width: SHELF_TILE_SIZE, height: SHELF_TILE_SIZE }}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={`album:${id}:${SHELF_TILE_SIZE}`}
        />
      </View>
      <Text
        numberOfLines={1}
        style={{
          color: theme.color.fg,
          fontSize: 14,
          fontWeight: "500",
          marginTop: 8,
        }}
      >
        {title}
      </Text>
      {subtitle ? (
        <Text
          numberOfLines={1}
          style={{ color: theme.color.fgMuted, fontSize: 12 }}
        >
          {subtitle}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * Editorial chart row: oversized rank numeral, artwork, then title with the
 * play count folded into the subtitle so long titles get the full width.
 */
function RankedTrackRow({
  theme,
  rank,
  track,
  plays,
  onPress,
}: {
  theme: ThemeTokens;
  rank: number;
  track: TrackListItem;
  plays: number;
  onPress: (t: TrackListItem) => void;
}) {
  const playsLabel = `${plays.toLocaleString()} ${plays === 1 ? "play" : "plays"}`;
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress(track);
      }}
      accessibilityRole="button"
      accessibilityLabel={
        track.artist ? `${track.title} by ${track.artist}` : track.title
      }
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: theme.space.lg,
        paddingVertical: theme.space.sm,
        gap: theme.space.md,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text
        style={{
          width: 30,
          color: rank === 1 ? theme.color.accent : theme.color.fgMuted,
          fontSize: 22,
          fontWeight: "700",
          letterSpacing: -0.5,
          fontVariant: ["tabular-nums"],
          textAlign: "center",
        }}
      >
        {rank}
      </Text>
      <CoverArt track={track} size={48} transitionMs={0} priority="low" />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text
          numberOfLines={1}
          style={{ color: theme.color.fg, fontSize: 16, fontWeight: "500" }}
        >
          {track.title}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            color: theme.color.fgMuted,
            fontSize: 13,
            fontVariant: ["tabular-nums"],
          }}
        >
          {track.artist ? `${track.artist} · ${playsLabel}` : playsLabel}
        </Text>
      </View>
    </Pressable>
  );
}

function BrowseLinkRow({
  theme,
  icon,
  label,
  divider,
  onPress,
}: {
  theme: ThemeTokens;
  icon: SymbolViewProps["name"];
  label: string;
  divider?: boolean;
  onPress: () => void;
}) {
  return (
    <>
      {divider && (
        <View
          style={{
            height: StyleSheet.hairlineWidth,
            marginLeft: 52,
            backgroundColor: theme.color.separator,
          }}
        />
      )}
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`Browse ${label}`}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: theme.space.md,
          paddingVertical: 13,
          gap: theme.space.md,
          backgroundColor: pressed ? theme.color.bgElev2 : "transparent",
        })}
      >
        <SymbolView
          name={icon}
          size={20}
          weight="medium"
          tintColor={theme.color.accent}
        />
        <Text style={{ flex: 1, color: theme.color.fg, fontSize: 16 }}>
          {label}
        </Text>
        <SymbolView
          name="chevron.right"
          size={13}
          weight="semibold"
          tintColor={theme.color.fgMuted}
        />
      </Pressable>
    </>
  );
}

function WelcomeCard({
  theme,
  onBrowse,
  onUpload,
}: {
  theme: ThemeTokens;
  onBrowse: () => void;
  onUpload: () => void;
}) {
  return (
    <View
      style={{
        marginHorizontal: theme.space.lg,
        backgroundColor: theme.color.bgElev1,
        borderRadius: theme.radius.lg,
        borderCurve: "continuous",
        padding: theme.space.xl,
        alignItems: "center",
        gap: theme.space.md,
      }}
    >
      <SymbolView name="sparkles" size={40} tintColor={theme.color.accent} />
      <Text
        style={{
          color: theme.color.fg,
          fontSize: 18,
          fontWeight: "600",
          textAlign: "center",
        }}
      >
        Make this place yours
      </Text>
      <Text
        style={{
          color: theme.color.fgMuted,
          fontSize: 14,
          textAlign: "center",
          maxWidth: 280,
        }}
      >
        Play a few songs and favorite the keepers — this page fills in with
        your recents, heavy rotation, and daily rediscoveries.
      </Text>
      <View style={{ flexDirection: "row", gap: theme.space.md, marginTop: 4 }}>
        <Pressable
          onPress={onBrowse}
          accessibilityRole="button"
          style={({ pressed }) => ({
            backgroundColor: theme.color.accent,
            borderRadius: 999,
            paddingHorizontal: 18,
            paddingVertical: 10,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Text
            style={{
              color: theme.color.onAccent,
              fontSize: 15,
              fontWeight: "600",
            }}
          >
            Browse library
          </Text>
        </Pressable>
        <Pressable
          onPress={onUpload}
          accessibilityRole="button"
          style={({ pressed }) => ({
            backgroundColor: theme.color.bgElev2,
            borderRadius: 999,
            paddingHorizontal: 18,
            paddingVertical: 10,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Text
            style={{ color: theme.color.fg, fontSize: 15, fontWeight: "600" }}
          >
            Upload music
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function HomeHeaderCapsule({
  theme,
  onSearchPress,
  onUploadPress,
}: {
  theme: ThemeTokens;
  onSearchPress: () => void;
  onUploadPress: () => void;
}) {
  const dividerColor =
    theme.scheme === "dark" ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.14)";
  return (
    <View style={styles.headerCapsuleWrap}>
      <AdaptiveGlass style={styles.headerCapsule}>
        <View style={styles.headerCapsuleRow}>
          <Pressable
            onPress={onSearchPress}
            accessibilityRole="button"
            accessibilityLabel="Search your library"
            style={({ pressed }) => [
              styles.headerCapsuleButton,
              pressed ? { opacity: 0.6 } : null,
            ]}
          >
            <SymbolView
              name="magnifyingglass"
              size={21}
              weight="semibold"
              tintColor={theme.color.fg}
            />
          </Pressable>
          <View
            style={[styles.headerCapsuleDivider, { backgroundColor: dividerColor }]}
          />
          <Pressable
            onPress={onUploadPress}
            accessibilityRole="button"
            accessibilityLabel="Upload music"
            style={({ pressed }) => [
              styles.headerCapsuleButton,
              pressed ? { opacity: 0.6 } : null,
            ]}
          >
            <SymbolView name="plus" size={24} tintColor={theme.color.fg} />
          </Pressable>
        </View>
      </AdaptiveGlass>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderCurve: "continuous",
    overflow: "hidden",
  },
  headerCapsuleWrap: {
    height: HEADER_CAPSULE_HEIGHT,
    overflow: "hidden",
    transform: [{ translateX: 8 }],
  },
  headerCapsule: {
    height: HEADER_CAPSULE_HEIGHT,
    borderRadius: HEADER_CAPSULE_HEIGHT / 2,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  headerCapsuleRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  headerCapsuleButton: {
    width: HEADER_ACTION_WIDTH,
    height: HEADER_CAPSULE_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
  },
  headerCapsuleDivider: {
    width: StyleSheet.hairlineWidth,
    height: 18,
    opacity: 0.7,
  },
});
