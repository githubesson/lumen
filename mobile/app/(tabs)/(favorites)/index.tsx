import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import type { FlashListRef } from "@shopify/flash-list";
import { useAnimatedRef, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { api, useAuth, type TrackListItem } from "@music-library/core";
import {
  FavoritesList,
  useFavoritesListModel,
} from "../../../components/favorites/favorites-list";
import { FavoritesNavBar } from "../../../components/favorites/favorites-nav-bar";
import { ModeWash } from "../../../components/favorites/mode-wash";
import { useFavoritesQuery } from "../../../context/favorites";
import {
  DEFAULT_HEADER_GEOMETRY,
  collapsedOffset,
  switchScrollTarget,
  type FavoritesMode,
  type HeaderGeometry,
} from "../../../lib/favorites-header";
import { qk } from "../../../lib/query-keys";
import { useTheme } from "../../../theme/theme";

/** After the first paint, so Recent's rows don't slow the tab's opening. */
const RECENT_PREMOUNT_MS = 600;

/**
 * Favorites and Recent, two lists behind one header. The native header is
 * hidden (its large title can't morph like this): each list's own header
 * scrolls with it, and FavoritesNavBar floats the bar, the heart | clock
 * switch and the docked Shuffle / Play above both, driven by the active
 * list's offset on the UI thread.
 */
export default function FavoritesScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const topInset = insets.top;
  const { me } = useAuth();
  const userId = me?.id;
  const [mode, setMode] = useState<FavoritesMode>("favorites");
  // Recent mounts shortly after the screen does (or on the first switch, if
  // sooner) and stays mounted, so it keeps its scroll position and is laid
  // out by the time the switch is tapped.
  const [recentMounted, setRecentMounted] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setRecentMounted(true), RECENT_PREMOUNT_MS);
    return () => clearTimeout(timer);
  }, []);

  const favoritesQuery = useFavoritesQuery();
  const recentQuery = useQuery({
    queryKey: qk.recent(userId),
    // The same limit as Home's recently played, so both share one entry.
    queryFn: ({ signal }) => api.listRecent(100, { signal }),
    enabled: recentMounted && !!userId,
  });

  const favorites = useFavoritesListModel("favorites", favoritesQuery.data);
  const recent = useFavoritesListModel("recent", recentQuery.data);
  const models = { favorites, recent };

  // Raw content offsets, written on the UI thread by each list. Under the
  // automatic inset a list at rest sits at minus the status bar's height.
  const favoritesOffset = useSharedValue(-topInset);
  const recentOffset = useSharedValue(-topInset);
  const offsets = useMemo(
    () => ({ favorites: favoritesOffset, recent: recentOffset }),
    [favoritesOffset, recentOffset],
  );
  const favoritesRef = useAnimatedRef<FlashListRef<TrackListItem>>();
  const recentRef = useAnimatedRef<FlashListRef<TrackListItem>>();

  const [geometry, setGeometry] = useState<Record<FavoritesMode, HeaderGeometry>>({
    favorites: DEFAULT_HEADER_GEOMETRY,
    recent: DEFAULT_HEADER_GEOMETRY,
  });
  const onGeometry = useCallback((list: FavoritesMode, next: HeaderGeometry) => {
    setGeometry((prev) => {
      const current = prev[list];
      if (
        current.titleRowY === next.titleRowY &&
        current.titleRowHeight === next.titleRowHeight &&
        current.controlsBottom === next.controlsBottom
      ) {
        return prev;
      }
      return { ...prev, [list]: next };
    });
  }, []);

  // A scroll a list couldn't take yet (not mounted, or no rows), applied
  // once it lays out its rows unless the user grabs it first.
  const pendingScroll = useRef<Partial<Record<FavoritesMode, number>>>({});

  const scrollList = useCallback(
    (list: FavoritesMode, offset: number) => {
      const ref = list === "favorites" ? favoritesRef : recentRef;
      ref.current?.scrollToOffset({ offset: offset - topInset, animated: false });
    },
    [favoritesRef, recentRef, topInset],
  );

  const onListContentSizeChange = useCallback(
    (list: FavoritesMode) => {
      const target = pendingScroll.current[list];
      if (target == null) return;
      const model = list === "favorites" ? favorites : recent;
      if (model.tracks.length === 0) return;
      delete pendingScroll.current[list];
      scrollList(list, target);
    },
    [favorites, recent, scrollList],
  );

  const onListScrollBeginDrag = useCallback((list: FavoritesMode) => {
    delete pendingScroll.current[list];
  }, []);

  const onSelectMode = useCallback(
    (next: FavoritesMode) => {
      if (next === mode) return;
      // A scroll still owed from an earlier switch no longer applies.
      delete pendingScroll.current[next];
      const nextMounted = next === "favorites" || recentMounted;
      const from = offsets[mode].get() + topInset;
      const to = nextMounted ? offsets[next].get() + topInset : 0;
      const target = switchScrollTarget(from, to, collapsedOffset(geometry[mode]));
      if (target != null) {
        // Move the bar's state now rather than a frame later, when the
        // list's scroll event lands, so the switch doesn't flicker.
        offsets[next].set(target - topInset);
        const nextModel = next === "favorites" ? favorites : recent;
        if (nextMounted && nextModel.tracks.length > 0) scrollList(next, target);
        else pendingScroll.current[next] = target;
      }
      if (next === "recent") setRecentMounted(true);
      setMode(next);
    },
    [mode, recentMounted, offsets, topInset, geometry, favorites, recent, scrollList],
  );

  const active = models[mode];

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <ModeWash
        theme={theme}
        mode={mode}
        offset={offsets[mode]}
        topInset={topInset}
      />
      <FavoritesList
        theme={theme}
        mode="favorites"
        active={mode === "favorites"}
        fadeIn={false}
        listRef={favoritesRef}
        offset={favoritesOffset}
        topInset={topInset}
        model={favorites}
        query={favoritesQuery}
        onGeometry={onGeometry}
        onContentSizeChange={onListContentSizeChange}
        onScrollBeginDrag={onListScrollBeginDrag}
      />
      {recentMounted ? (
        <FavoritesList
          theme={theme}
          mode="recent"
          active={mode === "recent"}
          fadeIn
          listRef={recentRef}
          offset={recentOffset}
          topInset={topInset}
          model={recent}
          query={recentQuery}
          onGeometry={onGeometry}
          onContentSizeChange={onListContentSizeChange}
          onScrollBeginDrag={onListScrollBeginDrag}
        />
      ) : null}
      <FavoritesNavBar
        theme={theme}
        mode={mode}
        offset={offsets[mode]}
        topInset={topInset}
        geometry={geometry[mode]}
        onSelectMode={onSelectMode}
        trackCount={active.tracks.length}
        onPlay={active.onPlay}
        onShuffle={active.onShuffle}
      />
    </View>
  );
}
