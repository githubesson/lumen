import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  Share as NativeShare,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Directory, File, Paths } from "expo-file-system";
import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import {
  ApiError,
  albumCoverUrl,
  api,
  type ReplayBucket,
  type ReplayData,
  type TrackListItem,
} from "@music-library/core";
import { Image } from "expo-image";
import { CoverArt } from "../../../components/cover-art";
import { EmptyState } from "../../../components/empty-state";
import { Card } from "../../../components/primitives";
import {
  useBottomDockInset,
  useDockScrollHandler,
} from "../../../components/dock/dock-context";
import { qk } from "../../../lib/query-keys";
import { usePlayQueue } from "../../../lib/use-play-queue";
import { useTheme, type ThemeTokens } from "../../../theme/theme";

// ── Period model ────────────────────────────────────────────────────────────

type Period =
  | { kind: "all" }
  | { kind: "this-year" }
  | { kind: "year"; year: number }
  | { kind: "this-month" }
  | { kind: "last-30" };

function periodKey(p: Period): string {
  switch (p.kind) {
    case "all":
      return "all";
    case "this-year":
      return "this-year";
    case "year":
      return `year:${p.year}`;
    case "this-month":
      return "this-month";
    case "last-30":
      return "last-30";
  }
}

function periodLabel(p: Period): string {
  switch (p.kind) {
    case "all":
      return "All time";
    case "this-year":
      return "This year";
    case "year":
      return String(p.year);
    case "this-month":
      return "This month";
    case "last-30":
      return "Last 30 days";
  }
}

function periodTitle(p: Period): string {
  switch (p.kind) {
    case "all":
      return "All time";
    case "this-year":
      return `This year · ${new Date().getFullYear()}`;
    case "year":
      return String(p.year);
    case "this-month":
      return new Date().toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      });
    case "last-30":
      return "Last 30 days";
  }
}

function periodRange(p: Period): {
  from?: string;
  to?: string;
  bucket?: ReplayBucket;
} {
  const now = new Date();
  switch (p.kind) {
    case "all":
      return { bucket: "month" };
    case "this-year": {
      const from = new Date(Date.UTC(now.getFullYear(), 0, 1));
      const to = new Date(Date.UTC(now.getFullYear() + 1, 0, 1));
      return { from: from.toISOString(), to: to.toISOString(), bucket: "month" };
    }
    case "year": {
      const from = new Date(Date.UTC(p.year, 0, 1));
      const to = new Date(Date.UTC(p.year + 1, 0, 1));
      return { from: from.toISOString(), to: to.toISOString(), bucket: "month" };
    }
    case "this-month": {
      const from = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
      const to = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1));
      return { from: from.toISOString(), to: to.toISOString(), bucket: "day" };
    }
    case "last-30": {
      const to = new Date();
      const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      return { from: from.toISOString(), to: to.toISOString(), bucket: "day" };
    }
  }
}

function buildPeriodOptions(availableYears: number[]): Period[] {
  const currentYear = new Date().getFullYear();
  const out: Period[] = [
    { kind: "this-year" },
    { kind: "last-30" },
    { kind: "this-month" },
  ];
  for (const y of availableYears) {
    if (y === currentYear) continue;
    out.push({ kind: "year", year: y });
  }
  out.push({ kind: "all" });
  return out;
}

// ── Formatting helpers ──────────────────────────────────────────────────────

function formatListeningTime(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes - days * 60 * 24) / 60);
  const minutes = totalMinutes - days * 60 * 24 - hours * 60;
  if (days >= 1) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours >= 1) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function activityBucketLabel(d: Date, bucket: ReplayBucket): string {
  switch (bucket) {
    case "day":
      return d.toLocaleDateString(undefined, { day: "numeric" });
    case "week":
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    case "month":
      return d.toLocaleDateString(undefined, { month: "narrow" });
  }
}

// Deterministic gradient seeded by a string, used for artist tiles that have
// no real cover art.
function hueFor(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

// ── Screen ──────────────────────────────────────────────────────────────────

export default function ReplayScreen() {
  const theme = useTheme();
  const dockInset = useBottomDockInset();
  const dockScroll = useDockScrollHandler();
  const router = useRouter();
  const [period, setPeriod] = useState<Period>({ kind: "this-year" });
  const [generating, setGenerating] = useState(false);
  const [sharingImage, setSharingImage] = useState(false);

  const range = useMemo(() => periodRange(period), [period]);
  const replayQuery = useQuery<ReplayData, ApiError>({
    queryKey: qk.replay(periodKey(period)),
    queryFn: ({ signal }) => api.getReplay(range, { signal }),
  });

  const data = replayQuery.data;
  const periodOptions = useMemo(
    () => buildPeriodOptions(data?.available_years ?? []),
    [data?.available_years],
  );

  const topTracks = useMemo<TrackListItem[]>(
    () => (data?.top_tracks ?? []) as TrackListItem[],
    [data?.top_tracks],
  );
  const playsById = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of data?.top_tracks ?? []) m.set(t.id, t.plays);
    return m;
  }, [data?.top_tracks]);
  const onTrackPress = usePlayQueue(topTracks);

  const onGenerate = useCallback(async () => {
    if (!data || data.summary.total_plays === 0) return;
    void Haptics.selectionAsync();
    setGenerating(true);
    try {
      const r = periodRange(period);
      const playlist = await api.generateReplayPlaylist({
        from: r.from,
        to: r.to,
        name: `Replay · ${periodTitle(period)}`,
        limit: 50,
      });
      router.push({
        pathname: "/(tabs)/(playlists)/[id]",
        params: { id: playlist.id },
      });
    } catch (err) {
      Alert.alert(
        "Couldn't create playlist",
        err instanceof ApiError ? err.message : "Try again in a moment.",
      );
    } finally {
      setGenerating(false);
    }
  }, [data, period, router]);

  const onShareImage = useCallback(async () => {
    if (!data || data.summary.total_plays === 0) return;
    void Haptics.selectionAsync();
    setSharingImage(true);
    try {
      const r = periodRange(period);
      const res = await api.getReplayImage({
        from: r.from,
        to: r.to,
        title: periodTitle(period),
      });
      const bytes = new Uint8Array(await res.arrayBuffer());

      const dir = new Directory(Paths.cache, "replay-share");
      dir.create({ idempotent: true, intermediates: true });
      const file = new File(
        dir,
        `replay-${periodKey(period).replace(/[^a-z0-9-]/gi, "-")}.png`,
      );
      file.create({ intermediates: true, overwrite: true });
      file.write(bytes);

      await NativeShare.share({ url: file.uri });
    } catch (err) {
      if (!isShareDismissal(err)) {
        Alert.alert(
          "Couldn't create share image",
          err instanceof ApiError ? err.message : "Try again in a moment.",
        );
      }
    } finally {
      setSharingImage(false);
    }
  }, [data, period]);

  const summary = data?.summary;
  const hasData = !!summary && summary.total_plays > 0;

  return (
    <ScrollView
      {...dockScroll}
      style={{ flex: 1, backgroundColor: theme.color.bg }}
      contentInsetAdjustmentBehavior="automatic"
      scrollIndicatorInsets={{ bottom: dockInset }}
      contentContainerStyle={{
        paddingTop: theme.space.sm,
        paddingBottom: dockInset + theme.space.xl,
        gap: theme.space.lg,
      }}
      refreshControl={
        <RefreshControl
          refreshing={replayQuery.isRefetching}
          onRefresh={() => void replayQuery.refetch()}
          tintColor={theme.color.fgMuted}
        />
      }
    >
      <PeriodPicker
        theme={theme}
        options={periodOptions}
        selected={period}
        onSelect={setPeriod}
      />

      {replayQuery.isLoading && !data ? (
        <EmptyState loading />
      ) : replayQuery.isError ? (
        <EmptyState message="Couldn't load Replay." />
      ) : !hasData ? (
        <ReplayEmptyState theme={theme} />
      ) : data && summary ? (
        <>
          <Hero theme={theme} period={period} summary={summary} />

          <SummaryGrid theme={theme} summary={summary} />

          {topTracks.length > 0 && (
            <Section theme={theme} eyebrow="On repeat" title="Top tracks">
              <Card
                style={{
                  marginHorizontal: theme.space.lg,
                  overflow: "hidden",
                }}
              >
                {topTracks.slice(0, 10).map((t, i) => (
                  <View key={t.id}>
                    {i > 0 && (
                      <View
                        style={{
                          height: StyleSheet.hairlineWidth,
                          marginLeft: 64,
                          backgroundColor: theme.color.separator,
                        }}
                      />
                    )}
                    <TopTrackRow
                      theme={theme}
                      rank={i + 1}
                      track={t}
                      plays={playsById.get(t.id) ?? 0}
                      onPress={onTrackPress}
                    />
                  </View>
                ))}
              </Card>
            </Section>
          )}

          {data.top_artists.length > 0 && (
            <Section theme={theme} eyebrow="On the marquee" title="Top artists">
              <HorizontalShelf>
                {data.top_artists.map((a, i) => (
                  <ArtistTile
                    key={a.id}
                    theme={theme}
                    rank={i + 1}
                    name={a.name}
                    plays={a.plays}
                    seed={a.id}
                    onPress={() =>
                      router.push({
                        pathname: "/(tabs)/(settings)/artists/[id]",
                        params: { id: a.id },
                      })
                    }
                  />
                ))}
              </HorizontalShelf>
            </Section>
          )}

          {data.top_albums.length > 0 && (
            <Section
              theme={theme}
              eyebrow="Played front to back"
              title="Top albums"
            >
              <HorizontalShelf>
                {data.top_albums.map((a, i) => (
                  <AlbumTile
                    key={a.id}
                    theme={theme}
                    rank={i + 1}
                    id={a.id}
                    title={a.title}
                    artist={a.artist}
                    plays={a.plays}
                    onPress={() =>
                      router.push({
                        pathname: "/(tabs)/(settings)/albums/[id]",
                        params: { id: a.id },
                      })
                    }
                  />
                ))}
              </HorizontalShelf>
            </Section>
          )}

          {data.activity.length > 0 && (
            <Section
              theme={theme}
              eyebrow="When you listened"
              title="Listening activity"
            >
              <ActivityChart
                theme={theme}
                buckets={data.activity}
                bucket={data.bucket}
              />
            </Section>
          )}

          {data.top_genres.length > 0 && (
            <Section
              theme={theme}
              eyebrow="What filled the room"
              title="Top genres"
            >
              <GenreList theme={theme} genres={data.top_genres} />
            </Section>
          )}

          <View
            style={{ paddingHorizontal: theme.space.lg, gap: theme.space.sm }}
          >
            <ReplayActionButton
              theme={theme}
              icon="music.note.list"
              label={generating ? "Creating playlist…" : "Generate playlist"}
              accessibilityLabel="Generate playlist from top tracks"
              busy={generating}
              onPress={onGenerate}
            />
            <ReplayActionButton
              theme={theme}
              icon="square.and.arrow.up"
              label={sharingImage ? "Creating image…" : "Share image"}
              accessibilityLabel="Share an image of your top songs"
              busy={sharingImage}
              onPress={() => void onShareImage()}
            />
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}

// The native share sheet rejects with a "dismissed" error when the user
// simply closes it; that's not a failure worth an alert.
function isShareDismissal(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return (
    message.includes("cancel") ||
    message.includes("dismiss") ||
    message.includes("did not share")
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function ReplayActionButton({
  theme,
  icon,
  label,
  accessibilityLabel,
  busy,
  onPress,
}: {
  theme: ThemeTokens;
  icon: "music.note.list" | "square.and.arrow.up";
  label: string;
  accessibilityLabel: string;
  busy: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => ({
        backgroundColor: theme.color.bgElev1,
        borderRadius: theme.radius.md,
        borderCurve: "continuous",
        paddingVertical: 14,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        opacity: pressed || busy ? 0.6 : 1,
      })}
    >
      {busy ? (
        <ActivityIndicator color={theme.color.fgMuted} />
      ) : (
        <SymbolView name={icon} size={18} tintColor={theme.color.accent} />
      )}
      <Text
        style={{
          color: theme.color.accent,
          fontSize: 16,
          fontWeight: "500",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function PeriodPicker({
  theme,
  options,
  selected,
  onSelect,
}: {
  theme: ThemeTokens;
  options: Period[];
  selected: Period;
  onSelect: (p: Period) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{
        paddingHorizontal: theme.space.lg,
        gap: 8,
      }}
    >
      {options.map((p) => {
        const active = periodKey(p) === periodKey(selected);
        return (
          <Pressable
            key={periodKey(p)}
            onPress={() => {
              void Haptics.selectionAsync();
              onSelect(p);
            }}
            style={({ pressed }) => ({
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 999,
              borderCurve: "continuous",
              backgroundColor: active
                ? theme.color.accent
                : theme.color.bgElev1,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text
              style={{
                color: active ? theme.color.onAccent : theme.color.fg,
                fontSize: 14,
                fontWeight: active ? "600" : "500",
              }}
            >
              {periodLabel(p)}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function Hero({
  theme,
  period,
  summary,
}: {
  theme: ThemeTokens;
  period: Period;
  summary: ReplayData["summary"];
}) {
  return (
    <View style={{ paddingHorizontal: theme.space.lg, gap: 4 }}>
      <Text
        style={{
          color: theme.color.fgMuted,
          fontSize: 12,
          letterSpacing: 0.8,
          textTransform: "uppercase",
          fontVariant: ["tabular-nums"],
        }}
      >
        Replay · {periodTitle(period)}
      </Text>
      <Text
        style={{
          color: theme.color.fg,
          fontSize: 40,
          fontWeight: "700",
          letterSpacing: -1,
          fontVariant: ["tabular-nums"],
        }}
      >
        {summary.total_plays.toLocaleString()}
      </Text>
      <Text style={{ color: theme.color.fgSubtle, fontSize: 15 }}>
        {summary.total_plays === 1 ? "play" : "plays"} ·{" "}
        {formatListeningTime(summary.total_ms)} listened
      </Text>
    </View>
  );
}

function SummaryGrid({
  theme,
  summary,
}: {
  theme: ThemeTokens;
  summary: ReplayData["summary"];
}) {
  const items: { label: string; value: string }[] = [
    {
      label: "Listening",
      value: formatListeningTime(summary.total_ms),
    },
    {
      label: "Tracks",
      value: summary.unique_tracks.toLocaleString(),
    },
    {
      label: "Artists",
      value: summary.unique_artists.toLocaleString(),
    },
    {
      label: "Top artist",
      value: summary.headline_artist?.name ?? "—",
    },
  ];
  return (
    <Card
      style={{
        marginHorizontal: theme.space.lg,
        overflow: "hidden",
        flexDirection: "row",
        flexWrap: "wrap",
      }}
    >
      {items.map((item, i) => {
        const isRight = i % 2 === 1;
        const isBottom = i >= 2;
        return (
          <View
            key={item.label}
            style={{
              width: "50%",
              padding: 14,
              borderLeftWidth: isRight ? StyleSheet.hairlineWidth : 0,
              borderTopWidth: isBottom ? StyleSheet.hairlineWidth : 0,
              borderColor: theme.color.separator,
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                color: theme.color.fgMuted,
                fontSize: 11,
                letterSpacing: 0.6,
                textTransform: "uppercase",
              }}
            >
              {item.label}
            </Text>
            <Text
              numberOfLines={1}
              style={{
                color: theme.color.fg,
                fontSize: 20,
                fontWeight: "600",
                marginTop: 4,
                fontVariant: ["tabular-nums"],
              }}
            >
              {item.value}
            </Text>
          </View>
        );
      })}
    </Card>
  );
}

function Section({
  theme,
  eyebrow,
  title,
  children,
}: {
  theme: ThemeTokens;
  eyebrow?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={{ gap: theme.space.sm }}>
      <View
        style={{
          paddingHorizontal: theme.space.lg,
          gap: 2,
        }}
      >
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

function ArtistTile({
  theme,
  rank,
  name,
  plays,
  seed,
  onPress,
}: {
  theme: ThemeTokens;
  rank: number;
  name: string;
  plays: number;
  seed: string;
  onPress: () => void;
}) {
  const hue = hueFor(seed);
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={`View artist ${name}`}
      style={({ pressed }) => ({ width: 128, opacity: pressed ? 0.7 : 1 })}
    >
      <View
        style={{
          width: 128,
          height: 128,
          borderRadius: theme.radius.md,
          borderCurve: "continuous",
          overflow: "hidden",
          backgroundColor: `hsl(${hue}, 50%, 50%)`,
        }}
      >
        <View
          style={{
            ...StyleSheet.absoluteFillObject,
            backgroundColor: `hsl(${(hue + 40) % 360}, 60%, 35%)`,
            opacity: 0.55,
          }}
        />
        <RankBadge rank={rank} />
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
        {name}
      </Text>
      <Text
        numberOfLines={1}
        style={{
          color: theme.color.fgMuted,
          fontSize: 12,
          fontVariant: ["tabular-nums"],
        }}
      >
        {plays} {plays === 1 ? "play" : "plays"}
      </Text>
    </Pressable>
  );
}

function AlbumTile({
  theme,
  rank,
  id,
  title,
  artist,
  plays,
  onPress,
}: {
  theme: ThemeTokens;
  rank: number;
  id: string;
  title: string;
  artist?: string;
  plays: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={`View album ${title}`}
      style={({ pressed }) => ({ width: 128, opacity: pressed ? 0.7 : 1 })}
    >
      <View
        style={{
          width: 128,
          height: 128,
          borderRadius: theme.radius.md,
          borderCurve: "continuous",
          overflow: "hidden",
          backgroundColor: theme.color.bgElev2,
        }}
      >
        <Image
          source={{ uri: albumCoverUrl(id, 256) }}
          style={{ width: 128, height: 128 }}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={`album:${id}:128`}
        />
        <RankBadge rank={rank} />
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
      <Text
        numberOfLines={1}
        style={{ color: theme.color.fgMuted, fontSize: 12 }}
      >
        {artist ? `${artist} · ` : ""}
        {plays} {plays === 1 ? "play" : "plays"}
      </Text>
    </Pressable>
  );
}

function RankBadge({ rank }: { rank: number }) {
  return (
    <View
      style={{
        position: "absolute",
        top: 6,
        left: 6,
        minWidth: 22,
        height: 22,
        paddingHorizontal: 7,
        borderRadius: 999,
        backgroundColor: "rgba(0,0,0,0.6)",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        style={{
          color: "#FFFFFF",
          fontSize: 11,
          fontWeight: "600",
          fontVariant: ["tabular-nums"],
        }}
      >
        {rank}
      </Text>
    </View>
  );
}

function TopTrackRow({
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
  const handlePress = () => {
    void Haptics.selectionAsync();
    onPress(track);
  };
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={
        track.artist ? `${track.title} by ${track.artist}` : track.title
      }
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        height: theme.row.height,
        paddingHorizontal: theme.space.lg,
        gap: theme.space.md,
        backgroundColor: pressed ? theme.color.bgElev2 : "transparent",
      })}
    >
      <Text
        style={{
          width: 22,
          color: theme.color.fgMuted,
          fontSize: 13,
          fontVariant: ["tabular-nums"],
          textAlign: "right",
        }}
      >
        {rank}
      </Text>
      <CoverArt track={track} size={40} transitionMs={0} priority="low" />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{ color: theme.color.fg, fontSize: 16, fontWeight: "500" }}
        >
          {track.title}
        </Text>
        {track.artist ? (
          <Text
            numberOfLines={1}
            style={{ color: theme.color.fgMuted, fontSize: 13 }}
          >
            {track.artist}
          </Text>
        ) : null}
      </View>
      <Text
        style={{
          color: theme.color.fgMuted,
          fontSize: 13,
          fontVariant: ["tabular-nums"],
        }}
      >
        {plays.toLocaleString()}
      </Text>
    </Pressable>
  );
}

function ActivityChart({
  theme,
  buckets,
  bucket,
}: {
  theme: ThemeTokens;
  buckets: ReplayData["activity"];
  bucket: ReplayBucket;
}) {
  const max = useMemo(
    () => buckets.reduce((m, b) => Math.max(m, b.plays), 0),
    [buckets],
  );
  // Show ~6 ticks max so labels don't overlap
  const labelStep = Math.max(1, Math.ceil(buckets.length / 6));

  return (
    <Card
      style={{
        marginHorizontal: theme.space.lg,
        padding: 14,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          height: 120,
          gap: 3,
        }}
      >
        {buckets.map((b) => {
          const pct = max > 0 ? (b.plays / max) * 100 : 0;
          return (
            <View
              key={b.bucket_start}
              style={{
                flex: 1,
                height: "100%",
                justifyContent: "flex-end",
              }}
            >
              <View
                style={{
                  height: `${pct}%`,
                  minHeight: 2,
                  backgroundColor: theme.color.accent,
                  borderRadius: 2,
                  borderTopLeftRadius: 3,
                  borderTopRightRadius: 3,
                }}
              />
            </View>
          );
        })}
      </View>
      <View
        style={{
          flexDirection: "row",
          marginTop: 6,
          gap: 3,
        }}
      >
        {buckets.map((b, i) => {
          const show = i % labelStep === 0;
          return (
            <View
              key={b.bucket_start}
              style={{ flex: 1, alignItems: "center" }}
            >
              {show ? (
                <Text
                  style={{
                    color: theme.color.fgMuted,
                    fontSize: 10,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {activityBucketLabel(new Date(b.bucket_start), bucket)}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </Card>
  );
}

function GenreList({
  theme,
  genres,
}: {
  theme: ThemeTokens;
  genres: ReplayData["top_genres"];
}) {
  const total = genres.reduce((acc, g) => acc + g.plays, 0);
  return (
    <Card
      style={{
        marginHorizontal: theme.space.lg,
        overflow: "hidden",
      }}
    >
      {genres.map((g, i) => {
        const pct = total > 0 ? (g.plays / total) * 100 : 0;
        return (
          <View key={g.genre}>
            {i > 0 && (
              <View
                style={{
                  height: StyleSheet.hairlineWidth,
                  marginLeft: 14,
                  backgroundColor: theme.color.separator,
                }}
              />
            )}
            <View
              style={{
                paddingHorizontal: 14,
                paddingVertical: 12,
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
              }}
            >
              <Text
                numberOfLines={1}
                style={{
                  color: theme.color.fg,
                  fontSize: 15,
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {g.genre}
              </Text>
              <View
                style={{
                  flex: 1.5,
                  height: 6,
                  borderRadius: 999,
                  backgroundColor: theme.color.bgElev2,
                  overflow: "hidden",
                }}
              >
                <View
                  style={{
                    width: `${pct}%`,
                    height: "100%",
                    backgroundColor: theme.color.accent,
                    borderRadius: 999,
                  }}
                />
              </View>
              <Text
                style={{
                  color: theme.color.fgMuted,
                  fontSize: 12,
                  width: 56,
                  textAlign: "right",
                  fontVariant: ["tabular-nums"],
                }}
              >
                {pct.toFixed(0)}%
              </Text>
            </View>
          </View>
        );
      })}
    </Card>
  );
}

function ReplayEmptyState({ theme }: { theme: ThemeTokens }) {
  return (
    <View
      style={{
        paddingHorizontal: theme.space.lg,
        paddingVertical: theme.space.xl * 2,
        alignItems: "center",
        gap: theme.space.md,
      }}
    >
      <SymbolView name="sparkles" size={48} tintColor={theme.color.fgMuted} />
      <Text
        style={{
          color: theme.color.fg,
          fontSize: 17,
          fontWeight: "600",
          textAlign: "center",
        }}
      >
        No plays in this window yet
      </Text>
      <Text
        style={{
          color: theme.color.fgMuted,
          fontSize: 14,
          textAlign: "center",
          maxWidth: 280,
        }}
      >
        Listen to some music from the Library tab and your stats will show up
        here.
      </Text>
    </View>
  );
}
