/** First-render regressions: a long queue must already exist when revealed. */
import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackListItem } from "@music-library/core";

import { QueueSection } from "../components/now-playing/queue-section";

const observed = vi.hoisted(() => ({
  data: [] as TrackListItem[],
  keys: [] as string[],
  presses: [] as (() => void)[],
  hints: [] as string[],
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Pressable: ({
    children,
    onPress,
    accessibilityHint,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityHint?: string;
  }) => {
    observed.presses.push(onPress);
    if (accessibilityHint) observed.hints.push(accessibilityHint);
    return <button>{children}</button>;
  },
  StyleSheet: { create: (styles: unknown) => styles },
  PixelRatio: { get: () => 2 },
}));
vi.mock("react-native-reanimated", () => ({
  default: {
    View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  },
  useSharedValue: (value: number) => ({ get: () => value, set: vi.fn() }),
  useAnimatedStyle: (fn: () => unknown) => fn(),
  useReducedMotion: () => false,
  ReduceMotion: { System: "system" },
  Easing: { bezier: vi.fn() },
  cancelAnimation: vi.fn(),
  withTiming: vi.fn(),
}));
vi.mock("react-native-worklets", () => ({ scheduleOnRN: vi.fn() }));
vi.mock("expo-image", () => ({ Image: { prefetch: vi.fn() } }));
vi.mock("../lib/downloads", () => ({ sessionCookieHeader: vi.fn() }));
vi.mock("../theme/theme", () => ({ useTheme: () => ({ color: {} }) }));
vi.mock("../components/now-playing/mode-pill", () => ({
  ModePill: () => null,
}));
vi.mock("../components/cover-art", () => ({
  CoverArt: ({ track }: { track: TrackListItem }) => (
    <span>cover:{track.id}</span>
  ),
}));
vi.mock("@shopify/flash-list", () => ({
  FlashList: ({
    data,
    renderItem,
    keyExtractor,
    ListEmptyComponent,
  }: {
    data: TrackListItem[];
    renderItem: (info: { item: TrackListItem; index: number }) => ReactNode;
    keyExtractor: (item: TrackListItem, index: number) => string;
    ListEmptyComponent: ReactNode;
  }) => {
    observed.data = data;
    observed.keys = data.map(keyExtractor);
    return (
      <div>
        {data.length
          ? data
              .slice(0, 6)
              .map((item, index) => (
                <React.Fragment key={keyExtractor(item, index)}>
                  {renderItem({ item, index })}
                </React.Fragment>
              ))
          : ListEmptyComponent}
      </div>
    );
  },
}));

const track = (id: number) =>
  ({ id: String(id), title: `Song ${id}`, artist: "Artist" }) as TrackListItem;
const queue = Array.from({ length: 100 }, (_, index) => track(index));
function render(
  overrides: Partial<React.ComponentProps<typeof QueueSection>> = {},
) {
  return renderToStaticMarkup(
    <QueueSection
      queue={queue}
      startIndex={1}
      queueOpen
      shuffle={false}
      repeat="off"
      onJumpToPosition={vi.fn()}
      onToggleShuffle={vi.fn()}
      onCycleRepeat={vi.fn()}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  observed.data = [];
  observed.keys = [];
  observed.presses = [];
  observed.hints = [];
});

describe("queue first render", () => {
  it("supplies the full long queue and visible artwork without waiting for effects or timers", () => {
    const html = render();
    expect(observed.data).toEqual(queue.slice(1));
    expect(html).toContain("Song 1");
    expect(html).toContain("cover:1");
    expect(html).toContain("99 songs");
    expect(html).not.toContain("Song 0");
  });

  it("keeps rows ready while the panel is hidden", () => {
    expect(render({ queueOpen: false })).toContain("Song 1");
    expect(observed.data).toHaveLength(99);
  });

  it("does not truncate a short queue to the initial draw batch", () => {
    render({ queue: queue.slice(0, 20) });
    expect(observed.data).toHaveLength(19);
  });

  it("shows the empty state immediately at the end of the queue", () => {
    const html = render({ startIndex: queue.length });
    expect(observed.data).toEqual([]);
    expect(html).toContain("Nothing else queued.");
    expect(html).toContain("0 songs");
  });

  it("keeps repeated songs distinct and jumps to the absolute queue position", () => {
    const onJumpToPosition = vi.fn();
    render({ queue: [track(0), track(1), track(1)], onJumpToPosition });
    expect(new Set(observed.keys).size).toBe(2);
    observed.presses[1]();
    expect(onJumpToPosition).toHaveBeenCalledWith(2);
  });

  it("numbers rows by their 1-based place in the whole queue", () => {
    render({ startIndex: 3 });
    expect(observed.hints[0]).toBe("Position 4 in queue. Double tap to play.");
  });

  it("counts a remote device's window against its whole queue", () => {
    // A 50-track window starting at 100 of 300, playing its 25th track.
    const onJumpToPosition = vi.fn();
    const html = render({
      queue: queue.slice(0, 50),
      startIndex: 25,
      positionOffset: 100,
      upcomingCount: 175,
      onJumpToPosition,
    });
    expect(html).toContain("175 songs");
    expect(observed.hints[0]).toBe("Position 126 in queue. Double tap to play.");
    // Jumps still use the window index; routed controls add the offset.
    observed.presses[0]();
    expect(onJumpToPosition).toHaveBeenCalledWith(25);
  });
});
