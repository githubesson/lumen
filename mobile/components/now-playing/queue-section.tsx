import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
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
  cancelAnimation,
  ReduceMotion,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { trackCoverUrl, type TrackListItem } from "@music-library/core";
import { useTheme } from "../../theme/theme";
import { sessionCookieHeader } from "../../lib/downloads";
import { ModePill } from "./mode-pill";
import { QUEUE_ROW_HEIGHT, QueueRow } from "./queue-row";

const QUEUE_EAGER_ROWS = 6;
const QUEUE_ADVANCE_ANIMATION_MS = 260;
const QUEUE_PREFETCH_LIMIT = 20;

type DisplayedQueue = {
  queue: TrackListItem[];
  startIndex: number;
};

/**
 * Keep the virtualized list ready while the parent animates the panel. Queue
 * changes never gate row rendering; only a natural advance holds the outgoing
 * row briefly so the remaining songs can slide into place.
 */
export const QueueSection = memo(function QueueSection({
  queueOpen,
  queue,
  startIndex,
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
  shuffle: boolean;
  repeat: "off" | "all" | "one";
  onJumpToPosition: (position: number) => void;
  onToggleShuffle: () => void;
  onCycleRepeat: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const upcomingLength = Math.max(0, queue.length - startIndex);
  const reducedMotion = useReducedMotion();
  const [displayedQueue, setDisplayedQueue] = useState<DisplayedQueue>(() => ({
    queue,
    startIndex,
  }));
  const displayedQueueRef = useRef(displayedQueue);
  const pendingQueueRef = useRef<DisplayedQueue | null>(null);
  const advanceGenerationRef = useRef(0);
  const prefetchedArtworkRef = useRef(new Set<string>());
  const queueAdvanceOffset = useSharedValue(0);

  // Reset the translation after React commits the new rows, so the outgoing
  // row cannot flash back into view between animation completion and commit.
  useLayoutEffect(() => {
    queueAdvanceOffset.set(0);
  }, [displayedQueue, queueAdvanceOffset]);

  useEffect(
    () => () => {
      pendingQueueRef.current = null;
      cancelAnimation(queueAdvanceOffset);
    },
    [queueAdvanceOffset],
  );

  const setDisplayedQueueState = useCallback((next: DisplayedQueue) => {
    displayedQueueRef.current = next;
    setDisplayedQueue(next);
  }, []);

  const finishQueueAdvance = useCallback(
    (generation: number) => {
      const pending = pendingQueueRef.current;
      if (!pending || generation !== advanceGenerationRef.current) return;
      pendingQueueRef.current = null;
      setDisplayedQueueState(pending);
    },
    [setDisplayedQueueState],
  );

  useEffect(() => {
    const nextQueue: DisplayedQueue = { queue, startIndex };
    const currentQueue = displayedQueueRef.current;

    if (
      currentQueue.queue === queue &&
      currentQueue.startIndex === startIndex
    ) {
      // A quick skip back may return to the still-displayed queue while an
      // advance is pending. Cancel it instead of committing the stale result.
      pendingQueueRef.current = null;
      cancelAnimation(queueAdvanceOffset);
      queueAdvanceOffset.set(0);
      return;
    }

    const pendingQueue = pendingQueueRef.current;
    if (
      queueOpen &&
      !reducedMotion &&
      pendingQueue?.queue === queue &&
      pendingQueue.startIndex === startIndex
    ) {
      return;
    }

    const canAnimateAdvance =
      queueOpen &&
      !reducedMotion &&
      currentQueue.queue === queue &&
      currentQueue.startIndex + 1 === startIndex &&
      currentQueue.startIndex + 1 < currentQueue.queue.length &&
      currentQueue.queue[currentQueue.startIndex + 1]?.id ===
        queue[startIndex]?.id;

    if (!canAnimateAdvance) {
      pendingQueueRef.current = null;
      cancelAnimation(queueAdvanceOffset);
      queueAdvanceOffset.set(0);
      setDisplayedQueueState(nextQueue);
      return;
    }

    const generation = ++advanceGenerationRef.current;
    pendingQueueRef.current = nextQueue;
    cancelAnimation(queueAdvanceOffset);
    queueAdvanceOffset.set(0);
    queueAdvanceOffset.set(
      withTiming(
        -QUEUE_ROW_HEIGHT,
        {
          duration: QUEUE_ADVANCE_ANIMATION_MS,
          easing: Easing.bezier(0.23, 1, 0.32, 1),
          reduceMotion: ReduceMotion.System,
        },
        (finished) => {
          if (finished) {
            scheduleOnRN(finishQueueAdvance, generation);
          }
        },
      ),
    );
  }, [
    finishQueueAdvance,
    reducedMotion,
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
    let cancelled = false;
    // Cover endpoints sit behind RequireUser, and expo-image's prefetch runs on
    // a native HTTP stack that does not share RN's cookie jar — so an
    // unauthenticated prefetch 401s and expo-image caches that failure against
    // the URL. The rows then render nothing, because the <Image> they mount
    // asks for the very URL now marked as failed. Attach the session cookie
    // (same reason the downloader does) and only mark a URL as prefetched once
    // it actually succeeded, so a transient failure can be retried.
    void (async () => {
      const headers = await sessionCookieHeader();
      if (cancelled) return;
      const ok = await Image.prefetch(urls, {
        cachePolicy: "memory-disk",
        headers,
      }).catch(() => false);
      if (ok && !cancelled) {
        for (const url of urls) prefetchedArtworkRef.current.add(url);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [queue, queueOpen, startIndex, upcomingLength]);

  const visibleUpcoming = useMemo(
    () => displayedQueue.queue.slice(displayedQueue.startIndex),
    [displayedQueue.queue, displayedQueue.startIndex],
  );

  const renderQueueItem = useCallback(
    ({ item, index }: ListRenderItemInfo<TrackListItem>) => (
      <QueueRow
        track={item}
        position={displayedQueue.startIndex + index}
        advanceOffset={queueAdvanceOffset}
        onJumpToPosition={onJumpToPosition}
      />
    ),
    [displayedQueue.startIndex, onJumpToPosition, queueAdvanceOffset],
  );

  const keyExtractor = useCallback(
    (item: TrackListItem, index: number) =>
      `${item.id}:${displayedQueue.startIndex + index}`,
    [displayedQueue.startIndex],
  );

  return (
    <View style={[styles.inner, style]}>
      <View style={styles.header}>
        <View style={styles.heading}>
          <Text
            accessibilityRole="header"
            style={[styles.title, { color: theme.color.fg }]}
          >
            Up next
          </Text>
          <Text style={{ color: theme.color.fgMuted, fontSize: 13 }}>
            {upcomingLength} {upcomingLength === 1 ? "song" : "songs"}
          </Text>
        </View>
        <View style={styles.pillsRow}>
          <ModePill
            style={styles.modePill}
            icon="shuffle"
            selected={shuffle}
            accessibilityLabel={
              shuffle ? "Turn shuffle off" : "Turn shuffle on"
            }
            onPress={onToggleShuffle}
          />
          <ModePill
            style={styles.modePill}
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
      </View>

      <FlashList
        data={visibleUpcoming}
        renderItem={renderQueueItem}
        keyExtractor={keyExtractor}
        drawDistance={QUEUE_ROW_HEIGHT * 2}
        maintainVisibleContentPosition={{ disabled: true }}
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
    </View>
  );
});

const styles = StyleSheet.create({
  inner: {
    flex: 1,
    minHeight: 0,
    gap: 10,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    paddingBottom: 4,
  },
  heading: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 20,
    fontWeight: "600",
    letterSpacing: -0.3,
  },
  modePill: {
    flex: 0,
    width: 44,
    height: 44,
    borderRadius: 22,
  },
  pillsRow: {
    flexDirection: "row",
    gap: 8,
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
