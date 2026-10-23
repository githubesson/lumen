import { Fragment, useCallback, useMemo, useState } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import Animated, {
  useAnimatedScrollHandler,
  useReducedMotion,
  useSharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import {
  api,
  displayText,
  tidalTrackInfoResult,
  trackInfoArtistAlbumId,
  trackInfoRows,
  trackInfoTidalId,
  useAuth,
  type TrackInfoLink,
} from "@music-library/core";
import { useBottomDockInset } from "../../../../components/dock/dock-context";
import { EmptyState } from "../../../../components/empty-state";
import { InfoGrid } from "../../../../components/track-info/info-grid";
import {
  AlbumLine,
  CompactMeta,
  FoldBackdrop,
  FoldCover,
  HeroActions,
  HeroMeta,
  InlineCover,
  useMetaFrame,
} from "../../../../components/track-info/player-hero";
import { qk } from "../../../../lib/query-keys";
import { trackInfoHref, trackInfoListItem } from "../../../../lib/track-info";
import { FOLD, trackInfoFold } from "../../../../lib/track-info-fold";
import { useTheme, type ThemeTokens } from "../../../../theme/theme";

const FACTS_GAP = 20;

/**
 * Track Info: the track as Now Playing shows it, folding into the player's
 * compact row as you scroll, then its credits, release and audio. Names with
 * a page open it in this tab's stack. Also mounted in the Favorites,
 * Playlists and Settings stacks, so opening it never changes the tab.
 */
export default function TrackInfoScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { me } = useAuth();
  const userId = me?.id;
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const dockInset = useBottomDockInset();
  const { width, height } = useWindowDimensions();
  const reducedMotion = useReducedMotion();

  const trackQuery = useQuery({
    queryKey: qk.track(userId, id),
    queryFn: ({ signal }) => api.getTrack(id!, { signal }),
    enabled: !!userId && !!id,
  });
  // A TIDAL track's row stores little, so the rest comes live from TIDAL on
  // each visit. Without it the screen shows what the row has.
  const tidalId = trackInfoTidalId(trackQuery.data);
  const tidalQuery = useQuery({
    queryKey: qk.tidalTrack(userId, tidalId ?? undefined),
    queryFn: ({ signal }) => api.getTidalTrack(tidalId!, { signal }),
    enabled: !!userId && !!tidalId,
    // One fresh fetch per visit: nothing kept from the last visit to show
    // in its place, and no background refetch to fail behind a good answer.
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // Show the stored fields rather than wait on a second slow attempt.
    retry: false,
  });
  // TIDAL's answer counts only when this visit's fetch got one: a failed
  // fetch keeps the last answer beside its error, and a paused one (offline)
  // has none.
  const tidal = tidalTrackInfoResult(
    tidalId,
    tidalQuery.data,
    tidalQuery.isError ? tidalQuery.error : null,
  );
  // An older server sends no TIDAL artist ids; the album's primary artist id
  // can still link the primary artist. Asked only once TIDAL has answered.
  const artistAlbumId = tidalQuery.isLoading
    ? null
    : trackInfoArtistAlbumId(trackQuery.data, tidal);
  const albumQuery = useQuery({
    queryKey: qk.tidalAlbum(userId, artistAlbumId ?? undefined),
    queryFn: ({ signal }) => api.getTidalAlbum(artistAlbumId!, { signal }),
    enabled: !!userId && !!artistAlbumId,
    // Only a link at stake: no second try.
    retry: false,
  });

  const [metaFrame, onMetaLayout] = useMetaFrame();
  const fold = useMemo(
    () => trackInfoFold(width, headerHeight, reducedMotion, metaFrame),
    [width, headerHeight, reducedMotion, metaFrame],
  );
  const scrollY = useSharedValue(0);
  const pinnedOnUI = useSharedValue(false);
  // Which row is in use, for touches and VoiceOver; the motion itself stays
  // on the UI thread.
  const [pinned, setPinned] = useState(false);
  const pinAt = fold.pin;
  const onScroll = useAnimatedScrollHandler(
    (event) => {
      const y = event.contentOffset.y;
      scrollY.set(y);
      const next = y >= pinAt;
      if (next !== pinnedOnUI.get()) {
        pinnedOnUI.set(next);
        scheduleOnRN(setPinned, next);
      }
    },
    [pinAt],
  );

  const t = trackQuery.data;
  const item = useMemo(() => (t ? trackInfoListItem(t) : null), [t]);
  const openLink = useCallback(
    (link: TrackInfoLink) => router.push(trackInfoHref(link)),
    [router],
  );

  if (trackQuery.isLoading || tidalQuery.isLoading) {
    return <EmptyState fill loading />;
  }
  if (trackQuery.isError || !t || !item) {
    return <EmptyState fill message="Couldn't load track." />;
  }

  const view = trackInfoRows(
    t,
    tidal,
    albumQuery.data?.id === artistAlbumId ? albumQuery.data : null,
  );
  const hero = { item, title: displayText(t.title), artists: view.artists };

  return (
    <>
      <Stack.Screen
        options={{
          title: "Track Info",
          // The pinned compact row names the track; the bar keeps only back.
          headerTitle: "",
          headerShadowVisible: false,
        }}
      />
      <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
        <Animated.ScrollView
          onScroll={onScroll}
          scrollEventThrottle={16}
          // Offsets start at 0 under the nav bar, which the fold math reads.
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustsScrollIndicatorInsets={false}
          scrollIndicatorInsets={{
            top: headerHeight,
            bottom: insets.bottom + dockInset,
          }}
          contentContainerStyle={{
            paddingTop: headerHeight,
            paddingBottom: insets.bottom + dockInset + 24,
            // Room to fold all the way, however few rows there are.
            minHeight: height + fold.stick,
          }}
        >
          <View style={{ width: fold.column, alignSelf: "center" }}>
            {fold.reducedMotion ? (
              <View
                style={{
                  paddingTop: FOLD.coverTop,
                  paddingBottom: FOLD.metaGap,
                }}
              >
                <InlineCover track={item} fold={fold} />
              </View>
            ) : (
              <View style={{ height: fold.spacer }} />
            )}
            <HeroMeta
              track={hero}
              fold={fold}
              scrollY={scrollY}
              hidden={pinned}
              onOpen={openLink}
              onLayout={onMetaLayout}
            />
            {view.album ? (
              <AlbumLine
                album={view.album}
                year={view.year}
                fold={fold}
                scrollY={scrollY}
                hidden={pinned}
                onOpen={openLink}
              />
            ) : null}

            <View
              style={{
                paddingHorizontal: theme.space.lg,
                paddingTop: 26,
                gap: FACTS_GAP,
              }}
            >
              {t.unavailable ? (
                <Note theme={theme}>
                  Removed from TIDAL, so it can&apos;t play.
                </Note>
              ) : null}
              {view.note ? <Note theme={theme}>{view.note}</Note> : null}

              {view.sections.map((section) => (
                <Fragment key={section.key}>
                  {section.rows.length > 0 ? (
                    <InfoGrid section={section} onOpen={openLink} />
                  ) : null}
                  {section.note ? (
                    <Note theme={theme} under={section.rows.length > 0}>
                      {section.note}
                    </Note>
                  ) : null}
                </Fragment>
              ))}
            </View>
          </View>
        </Animated.ScrollView>

        <FoldBackdrop fold={fold} scrollY={scrollY} pinned={pinned} />
        <FoldCover track={item} fold={fold} scrollY={scrollY} />
        <CompactMeta
          track={hero}
          fold={fold}
          scrollY={scrollY}
          pinned={pinned}
          onOpen={openLink}
        />
        <HeroActions track={item} fold={fold} scrollY={scrollY} />
      </View>
    </>
  );
}

function Note({
  children,
  theme,
  under,
}: {
  children: React.ReactNode;
  theme: ThemeTokens;
  /** Sits under the block it's about rather than a full gap away. */
  under?: boolean;
}) {
  return (
    <Text
      style={{
        alignSelf: "stretch",
        paddingHorizontal: 4,
        marginTop: under ? theme.space.sm - FACTS_GAP : 0,
        fontSize: 13,
        color: theme.color.fgMuted,
      }}
    >
      {children}
    </Text>
  );
}
