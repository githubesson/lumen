import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  PixelRatio,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { FlashList, type ListRenderItemInfo } from "@shopify/flash-list";
import { Image } from "expo-image";
import {
  Easing,
  runOnJS,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { trackCoverUrl, type TrackListItem } from "@music-library/core";
import { useTheme } from "../../theme/theme";
import { ModePill } from "./mode-pill";
import { QUEUE_ROW_HEIGHT, QueueRow } from "./queue-row";

const QUEUE_OPEN_ANIMATION_MS = 240;
const QUEUE_DEFER_THRESHOLD = 20;
const QUEUE_EAGER_ROWS = 6;
const QUEUE_ARTWORK_DELAY_MS = 140;
const QUEUE_ADVANCE_ANIMATION_MS = 260;
const QUEUE_PREFETCH_LIMIT = 20;

type DisplayedQueue = {
  queue: TrackListItem[];
  startIndex: number;
};

/**
 * "Up next" panel of the Now Playing screen: shuffle/repeat mode pills, the
 * "From:" lead, and the upcoming-tracks list. Long queues defer list mount
 * and artwork until the open animation settles so the sheet transition stays
 * smooth, natural queue advances slide rows up by one, and upcoming artwork
 * is prefetched into the image cache while the panel is open.
 */
export const QueueSection = memo(function QueueSection({
  queueOpen,
  queue,
  startIndex,
  artistLabel,
  shuffle,
  repeat,
  onJumpToPosition,
  onToggleShuffle,
  onCycleRepeat,
  style,
}: {
  queueOpen: boolean;
  queue: TrackListItem[];
  startIndex: number;
  artistLabel: string;
  shuffle: boolean;
  repeat: "off" | "all" | "one";
  onJumpToPosition: (position: number) => void;
  onToggleShuffle: () => void;
  onCycleRepeat: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const upcomingLength = Math.max(0, queue.length - startIndex);
  const [listReady, setListReady] = useState(
    queueOpen && upcomingLength <= QUEUE_DEFER_THRESHOLD,
  );
  const [showArtwork, setShowArtwork] = useState(
    queueOpen && upcomingLength <= QUEUE_DEFER_THRESHOLD,
  );
  const [renderCount, setRenderCount] = useState(() =>
    Math.min(upcomingLength, QUEUE_EAGER_ROWS),
  );
  const [displayedQueue, setDisplayedQueue] = useState<DisplayedQueue>(() => ({
    queue,
    startIndex,
  }));
  const listReadyRef = useRef(listReady);
  const displayedQueueRef = useRef(displayedQueue);
  const pendingQueueRef = useRef<DisplayedQueue | null>(null);
  const prefetchedArtworkRef = useRef(new Set<string>());
  const queueAdvanceOffset = useSharedValue(0);

  useEffect(() => {
    listReadyRef.current = listReady;
  }, [listReady]);

  const setDisplayedQueueState = useCallback((next: DisplayedQueue) => {
    displayedQueueRef.current = next;
    setDisplayedQueue(next);
  }, []);

  const finishQueueAdvance = useCallback(() => {
    const pending = pendingQueueRef.current;
    pendingQueueRef.current = null;
    queueAdvanceOffset.value = 0;
    if (pending) {
      setDisplayedQueueState(pending);
    }
  }, [queueAdvanceOffset, setDisplayedQueueState]);

  useEffect(() => {
    const eagerCount = Math.min(upcomingLength, QUEUE_EAGER_ROWS);
    let raf = 0;
    let listTimer: ReturnType<typeof setTimeout> | null = null;
    let artworkTimer: ReturnType<typeof setTimeout> | null = null;

    if (!queueOpen) {
      setListReady(false);
      setShowArtwork(false);
      setRenderCount(eagerCount);
      return;
    }

    if (upcomingLength <= QUEUE_DEFER_THRESHOLD) {
      setListReady(true);
      setShowArtwork(true);
      setRenderCount(upcomingLength);
      return;
    }

    setListReady(false);
    setShowArtwork(false);
    setRenderCount(eagerCount);
    listTimer = setTimeout(() => {
      startTransition(() => {
        setListReady(true);
        setRenderCount(eagerCount);
      });
      raf = requestAnimationFrame(() => {
        startTransition(() => {
          setRenderCount(upcomingLength);
        });
      });
      artworkTimer = setTimeout(() => {
        startTransition(() => {
          setShowArtwork(true);
        });
      }, QUEUE_ARTWORK_DELAY_MS);
    }, QUEUE_OPEN_ANIMATION_MS + 32);

    return () => {
      if (listTimer) clearTimeout(listTimer);
      if (artworkTimer) clearTimeout(artworkTimer);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [queueOpen, upcomingLength]);

  useEffect(() => {
    const nextQueue: DisplayedQueue = { queue, startIndex };
    const currentQueue = displayedQueueRef.current;

    if (
      currentQueue.queue === queue &&
      currentQueue.startIndex === startIndex
    ) {
      return;
    }

    const pendingQueue = pendingQueueRef.current;
    if (
      pendingQueue?.queue === queue &&
      pendingQueue.startIndex === startIndex
    ) {
      return;
    }

    const canAnimateAdvance =
      queueOpen &&
      listReady &&
      currentQueue.queue === queue &&
      currentQueue.startIndex + 1 === startIndex &&
      currentQueue.startIndex + 1 < currentQueue.queue.length &&
      currentQueue.queue[currentQueue.startIndex + 1]?.id === queue[startIndex]?.id;

    if (!canAnimateAdvance) {
      pendingQueueRef.current = null;
      queueAdvanceOffset.value = 0;
      setDisplayedQueueState(nextQueue);
      return;
    }

    pendingQueueRef.current = nextQueue;
    queueAdvanceOffset.value = 0;
    queueAdvanceOffset.value = withTiming(
      -QUEUE_ROW_HEIGHT,
      {
        duration: QUEUE_ADVANCE_ANIMATION_MS,
        easing: Easing.bezier(0.2, 0.8, 0.2, 1),
      },
      (finished) => {
        if (finished) {
          runOnJS(finishQueueAdvance)();
        }
      },
    );
  }, [
    finishQueueAdvance,
    listReady,
    queueAdvanceOffset,
    queueOpen,
    setDisplayedQueueState,
    startIndex,
    queue,
  ]);

  useEffect(() => {
    if (!queueOpen || upcomingLength === 0) return;
    const requestSize = Math.max(1, Math.round(44 * PixelRatio.get()));
    const urls = Array.from(
      new Set(
        queue
          .slice(startIndex, startIndex + QUEUE_PREFETCH_LIMIT)
          .filter((track) => track.has_cover !== false)
          .map((track) => trackCoverUrl(track, requestSize)),
      ),
    ).filter((url) => !prefetchedArtworkRef.current.has(url));
    if (urls.length === 0) return;
    for (const url of urls) prefetchedArtworkRef.current.add(url);
    void Image.prefetch(urls, "memory-disk");
  }, [queue, queueOpen, startIndex, upcomingLength]);

  const isAdvancingQueue = displayedQueue.startIndex !== startIndex;
  const visibleUpcoming = useMemo(() => {
    if (!listReady) return [];
    return displayedQueue.queue.slice(
      displayedQueue.startIndex,
      Math.min(
        displayedQueue.queue.length,
        displayedQueue.startIndex + renderCount + (isAdvancingQueue ? 1 : 0),
      ),
    );
  }, [
    displayedQueue.queue,
    displayedQueue.startIndex,
    isAdvancingQueue,
    listReady,
    renderCount,
  ]);

  const renderQueueItem = useCallback(
    ({ item, index }: ListRenderItemInfo<TrackListItem>) => (
      <QueueRow
        track={item}
        position={displayedQueue.startIndex + index}
        advanceOffset={queueAdvanceOffset}
        showArtwork={showArtwork}
        onJumpToPosition={onJumpToPosition}
      />
    ),
    [
      displayedQueue.startIndex,
      onJumpToPosition,
      queueAdvanceOffset,
      showArtwork,
    ],
  );

  const keyExtractor = useCallback(
    (item: TrackListItem, index: number) =>
      `${item.id}:${displayedQueue.startIndex + index}`,
    [displayedQueue.startIndex],
  );

  return (
    <View style={[styles.inner, style]}>
      <View style={styles.pillsRow}>
        <ModePill
          icon="shuffle"
          selected={shuffle}
          accessibilityLabel={shuffle ? "Turn shuffle off" : "Turn shuffle on"}
          onPress={onToggleShuffle}
        />
        <ModePill
          icon={repeat === "one" ? "repeat.1" : "repeat"}
          selected={repeat !== "off"}
          accessibilityLabel={
            repeat === "off"
              ? "Repeat off. Turn on repeat"
              : repeat === "all"
                ? "Repeat all. Turn on repeat one"
                : "Repeat one. Turn repeat off"
          }
          onPress={onCycleRepeat}
        />
      </View>

      <View style={styles.lead}>
        <Text style={{ color: theme.color.fgMuted, fontSize: 14 }}>
          From: {artistLabel}
        </Text>
      </View>

      {listReady ? (
        <FlashList
          data={visibleUpcoming}
          renderItem={renderQueueItem}
          keyExtractor={keyExtractor}
          drawDistance={QUEUE_ROW_HEIGHT * 2}
          removeClippedSubviews
          overrideProps={{
            initialDrawBatchSize: Math.min(
              QUEUE_EAGER_ROWS,
              visibleUpcoming.length,
            ),
          }}
          scrollEnabled={queueOpen}
          showsVerticalScrollIndicator={false}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={{ color: theme.color.fgMuted }}>
                Nothing else queued.
              </Text>
            </View>
          }
        />
      ) : (
        <View style={styles.list} />
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  inner: {
    flex: 1,
    minHeight: 0,
    gap: 10,
  },
  pillsRow: {
    flexDirection: "row",
    gap: 8,
  },
  lead: {
    gap: 4,
  },
  list: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  listContent: {
    paddingBottom: 12,
  },
  emptyState: {
    paddingVertical: 48,
    alignItems: "center",
  },
});
