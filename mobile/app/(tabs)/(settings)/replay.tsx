import { useCallback, useMemo, useState } from "react";
import {
  Alert,
  RefreshControl,
  ScrollView,
  Share as NativeShare,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Directory, File, Paths } from "expo-file-system";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import {
  ApiError,
  api,
  type ReplayData,
  type TrackListItem,
} from "@music-library/core";
import { EmptyState } from "../../../components/empty-state";
import {
  useBottomDockInset,
  useDockScrollHandler,
} from "../../../components/dock/dock-context";
import { ActivityChart } from "../../../components/replay/activity-chart";
import { playsLabel } from "../../../components/replay/format";
import { GenreList } from "../../../components/replay/genre-list";
import { HorizontalShelf } from "../../../components/horizontal-shelf";
import { Section } from "../../../components/section";
import {
  buildPeriodOptions,
  periodKey,
  periodRange,
  periodTitle,
  type Period,
} from "../../../components/replay/period";
import { PeriodPicker } from "../../../components/replay/period-picker";
import { ReplayActionButton } from "../../../components/replay/replay-action-button";
import { ReplayEmptyState } from "../../../components/replay/replay-empty-state";
import { ReplayHero } from "../../../components/replay/replay-hero";
import { RankedShelfTile } from "../../../components/replay/ranked-shelf-tile";
import { SummaryGrid } from "../../../components/replay/summary-grid";
import { TopTrackList } from "../../../components/replay/top-track-list";
import { qk } from "../../../lib/query-keys";
import { usePlayQueue } from "../../../lib/use-play-queue";
import { useTheme } from "../../../theme/theme";

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
        options={periodOptions}
        selected={period}
        onSelect={setPeriod}
      />

      {replayQuery.isLoading && !data ? (
        <EmptyState loading />
      ) : replayQuery.isError ? (
        <EmptyState message="Couldn't load Replay." />
      ) : !hasData ? (
        <ReplayEmptyState />
      ) : data && summary ? (
        <>
          <ReplayHero periodTitle={periodTitle(period)} summary={summary} />

          <SummaryGrid
            summary={summary}
            style={{ marginHorizontal: theme.space.lg }}
          />

          {topTracks.length > 0 && (
            <Section eyebrow="On repeat" title="Top tracks">
              <TopTrackList
                tracks={topTracks.slice(0, 10)}
                playsById={playsById}
                onTrackPress={onTrackPress}
                style={{ marginHorizontal: theme.space.lg }}
              />
            </Section>
          )}

          {data.top_artists.length > 0 && (
            <Section eyebrow="On the marquee" title="Top artists">
              <HorizontalShelf>
                {data.top_artists.map((a, i) => (
                  <RankedShelfTile
                    key={a.id}
                    rank={i + 1}
                    title={a.name}
                    subtitle={playsLabel(a.plays)}
                    subtitleTabular
                    accessibilityLabel={`View artist ${a.name}`}
                    art={{ kind: "gradient", seed: a.id }}
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
              eyebrow="Played front to back"
              title="Top albums"
            >
              <HorizontalShelf>
                {data.top_albums.map((a, i) => (
                  <RankedShelfTile
                    key={a.id}
                    rank={i + 1}
                    title={a.title}
                    subtitle={`${a.artist ? `${a.artist} · ` : ""}${playsLabel(a.plays)}`}
                    accessibilityLabel={`View album ${a.title}`}
                    art={{ kind: "album", albumId: a.id }}
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
              eyebrow="When you listened"
              title="Listening activity"
            >
              <ActivityChart
                buckets={data.activity}
                bucket={data.bucket}
                style={{ marginHorizontal: theme.space.lg }}
              />
            </Section>
          )}

          {data.top_genres.length > 0 && (
            <Section
              eyebrow="What filled the room"
              title="Top genres"
            >
              <GenreList
                genres={data.top_genres}
                style={{ marginHorizontal: theme.space.lg }}
              />
            </Section>
          )}

          <View
            style={{ paddingHorizontal: theme.space.lg, gap: theme.space.sm }}
          >
            <ReplayActionButton
              icon="music.note.list"
              label={generating ? "Creating playlist…" : "Generate playlist"}
              accessibilityLabel="Generate playlist from top tracks"
              busy={generating}
              onPress={onGenerate}
            />
            <ReplayActionButton
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
