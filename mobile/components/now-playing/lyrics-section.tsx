import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { api, type TrackListItem } from "@music-library/core";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { usePlayerTime } from "../../context/player";
import { qk } from "../../lib/query-keys";
import { useTheme } from "../../theme/theme";

interface SyncedLine {
  time: number;
  text: string;
  section: boolean;
}

interface PlainLine {
  text: string;
  section: boolean;
}

const LINE_TRANSITION = {
  duration: 320,
  easing: Easing.bezier(0.22, 1, 0.36, 1),
};

export function LyricsSection({ track }: { track: TrackListItem }) {
  const theme = useTheme();
  const time = usePlayerTime();
  const scrollRef = useRef<ScrollView>(null);
  const lineOffsets = useRef(new Map<number, number>());
  const [viewportHeight, setViewportHeight] = useState(0);
  const lyricsQuery = useQuery({
    queryKey: qk.lyrics(track.id, track.title, track.artist, track.album_title),
    queryFn: () =>
      api.getLyrics({
        track_name: track.title,
        artist_name: track.artist,
        album_name: track.album_title,
        duration: track.duration_ms
          ? Math.round(track.duration_ms / 1000)
          : undefined,
      }),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const syncedLines = useMemo(
    () => parseSyncedLyrics(lyricsQuery.data?.syncedLyrics),
    [lyricsQuery.data?.syncedLyrics],
  );
  const plainLines = useMemo(
    () => parsePlainLyrics(lyricsQuery.data?.plainLyrics),
    [lyricsQuery.data?.plainLyrics],
  );
  const activeIndex = useMemo(
    () => activeLineIndex(syncedLines, time.currentTime),
    [syncedLines, time.currentTime],
  );

  useEffect(() => {
    if (activeIndex < 0) return;
    const offset = lineOffsets.current.get(activeIndex);
    if (offset === undefined) return;
    scrollRef.current?.scrollTo({
      y: Math.max(0, offset - viewportHeight * 0.36),
      animated: true,
    });
  }, [activeIndex, viewportHeight]);

  useEffect(() => {
    lineOffsets.current.clear();
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [track.id]);

  if (lyricsQuery.isPending) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={theme.color.fgMuted} />
      </View>
    );
  }

  if (lyricsQuery.isError) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          padding: 20,
        }}
      >
        <Text
          selectable
          style={{ color: theme.color.fgMuted, textAlign: "center" }}
        >
          Lyrics unavailable
        </Text>
      </View>
    );
  }

  if (lyricsQuery.data?.instrumental) {
    return <LyricsMessage text="Instrumental" />;
  }

  if (!syncedLines.length && !plainLines.length) {
    return <LyricsMessage text="No lyrics found" />;
  }

  return (
    <ScrollView
      ref={scrollRef}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}
      contentContainerStyle={{
        gap: syncedLines.length ? 12 : 10,
        paddingTop: syncedLines.length ? 22 : 10,
        paddingHorizontal: 4,
        paddingBottom: syncedLines.length ? 96 : 40,
      }}
    >
      {syncedLines.length
        ? syncedLines.map((line, index) => (
            <SyncedLyricLine
              key={`${line.time}-${index}`}
              line={line}
              state={
                index === activeIndex
                  ? "active"
                  : index < activeIndex
                    ? "past"
                    : "upcoming"
              }
              activeWordIndex={
                index === activeIndex && !line.section
                  ? wordIndexForLine(
                      line,
                      syncedLines[index + 1],
                      time.currentTime,
                      Math.max(1, time.duration),
                    )
                  : null
              }
              onLayout={(event) => {
                lineOffsets.current.set(index, event.nativeEvent.layout.y);
              }}
            />
          ))
        : plainLines.map((line, index) => (
            <Animated.View
              key={`${index}-${line.text}`}
              entering={FadeIn.duration(180)}
              exiting={FadeOut.duration(120)}
            >
              <Text
                selectable
                style={
                  line.section
                    ? {
                        color: theme.color.accent,
                        fontSize: 12,
                        fontWeight: "700",
                        letterSpacing: 0.6,
                        lineHeight: 17,
                        textTransform: "uppercase",
                      }
                    : {
                        color: theme.color.fgSubtle,
                        fontSize: 17,
                        lineHeight: 25,
                      }
                }
              >
                {line.text}
              </Text>
            </Animated.View>
          ))}
    </ScrollView>
  );
}

function LyricsMessage({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Text selectable style={{ color: theme.color.fgMuted }}>
        {text}
      </Text>
    </View>
  );
}

function SyncedLyricLine({
  line,
  state,
  activeWordIndex,
  onLayout,
}: {
  line: SyncedLine;
  state: "active" | "past" | "upcoming";
  activeWordIndex: number | null;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const theme = useTheme();
  const active = useSharedValue(state === "active" ? 1 : 0);
  const past = useSharedValue(state === "past" ? 1 : 0);

  useEffect(() => {
    active.value = withTiming(state === "active" ? 1 : 0, LINE_TRANSITION);
    past.value = withTiming(state === "past" ? 1 : 0, LINE_TRANSITION);
  }, [active, past, state]);

  const animatedStyle = useAnimatedStyle(() => {
    const inactiveOpacity = past.value * 0.28 + (1 - past.value) * 0.42;
    const inactiveScale = past.value * 0.97 + (1 - past.value) * 0.985;
    return {
      opacity: active.value + (1 - active.value) * inactiveOpacity,
      transform: [{ scale: active.value + (1 - active.value) * inactiveScale }],
    };
  });
  const textStyle = useAnimatedStyle(() => ({
    color: line.section
      ? theme.color.accent
      : interpolateColor(
          active.value,
          [0, 1],
          [theme.color.fgMuted, theme.color.fg],
        ),
  }));

  const words =
    state === "active" && !line.section
      ? line.text.trim().split(/\s+/).filter(Boolean)
      : null;

  return (
    <Animated.View
      onLayout={onLayout}
      style={[{ transformOrigin: "left center" }, animatedStyle]}
    >
      {words ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          {words.map((word, index) => (
            <AnimatedLyricWord
              key={`${index}-${word}`}
              state={
                activeWordIndex === null || index > activeWordIndex
                  ? "upcoming"
                  : index === activeWordIndex
                    ? "active"
                    : "past"
              }
              trailingSpace={index < words.length - 1}
            >
              {word}
            </AnimatedLyricWord>
          ))}
        </View>
      ) : (
        <Animated.Text
          selectable
          style={[
            {
              fontSize: line.section ? 12 : state === "active" ? 19 : 18,
              fontWeight: line.section
                ? "700"
                : state === "active"
                  ? "500"
                  : "400",
              lineHeight: line.section ? 18 : 27,
              letterSpacing: line.section ? 0.6 : 0,
              textTransform: line.section ? "uppercase" : "none",
            },
            textStyle,
          ]}
        >
          {line.text}
        </Animated.Text>
      )}
    </Animated.View>
  );
}

function AnimatedLyricWord({
  children,
  state,
  trailingSpace,
}: {
  children: string;
  state: "past" | "active" | "upcoming";
  trailingSpace: boolean;
}) {
  const theme = useTheme();
  const progress = useSharedValue(
    state === "active" ? 1 : state === "past" ? 2 : 0,
  );

  useEffect(() => {
    progress.value = withTiming(
      state === "active" ? 1 : state === "past" ? 2 : 0,
      {
        duration: 220,
        easing: Easing.bezier(0.22, 1, 0.36, 1),
      },
    );
  }, [progress, state]);

  const animatedStyle = useAnimatedStyle(() => {
    const distanceFromActive = Math.abs(progress.value - 1);
    const activeAmount = Math.max(0, 1 - distanceFromActive);
    const completedAmount = Math.max(0, progress.value - 1);
    const opacity = 0.72 + activeAmount * 0.28 + completedAmount * 0.16;

    return {
      color: interpolateColor(
        progress.value,
        [0, 1, 2],
        [`${theme.color.fg}61`, theme.color.fg, `${theme.color.fg}AE`],
      ),
      opacity,
      transform: [{ scale: 1 + activeAmount * 0.04 }],
      textShadowColor: `${theme.color.fg}29`,
      textShadowOffset: { width: 0, height: 0 },
      textShadowRadius: activeAmount * 10,
    };
  });

  return (
    <Animated.Text
      selectable
      style={[
        {
          fontSize: 19,
          lineHeight: 27,
          fontWeight: state === "active" ? "600" : "500",
        },
        animatedStyle,
      ]}
    >
      {trailingSpace ? `${children} ` : children}
    </Animated.Text>
  );
}

function parseSyncedLyrics(text?: string | null): SyncedLine[] {
  if (!text) return [];
  const lines: SyncedLine[] = [];
  for (const rawLine of text.split("\n")) {
    const lyricText = rawLine
      .replace(/\[\d{1,3}:\d{2}(?:\.\d{1,3})?\]/g, "")
      .trim();
    for (const stamp of rawLine.matchAll(
      /\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g,
    )) {
      const time =
        Number(stamp[1]) * 60 +
        Number(stamp[2]) +
        Number(`0.${(stamp[3] ?? "0").padEnd(3, "0")}`);
      if (Number.isFinite(time) && lyricText) {
        lines.push({
          time,
          text: lyricText,
          section: /^\[[^\]]+\]$/.test(lyricText),
        });
      }
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

function parsePlainLyrics(text?: string | null): PlainLine[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ text: line, section: /^\[[^\]]+\]$/.test(line) }));
}

function activeLineIndex(lines: SyncedLine[], currentTime: number): number {
  let active = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.time > currentTime) break;
    active = index;
  }
  return active;
}

function wordIndexForLine(
  line: SyncedLine,
  next: SyncedLine | undefined,
  currentTime: number,
  duration: number,
): number | null {
  const words = line.text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const estimatedTail = Math.min(
    8,
    Math.max(1.2, line.text.replace(/\s+/g, "").length * 0.085),
  );
  const end = next
    ? Math.max(next.time, line.time + 0.2)
    : Math.max(Math.min(duration, line.time + estimatedTail), line.time + 0.2);
  const lineDuration = Math.max(0.2, end - line.time);
  const elapsed = Math.min(lineDuration, Math.max(0, currentTime - line.time));
  const weights = words.map((word) =>
    Math.max(1, word.replace(/[^\p{L}\p{N}]/gu, "").length || word.length),
  );
  const totalWeight = Math.max(
    1,
    weights.reduce((sum, value) => sum + value, 0),
  );
  const minSlice = Math.min(0.14, lineDuration / words.length);
  const distributableDuration = Math.max(
    0,
    lineDuration - minSlice * words.length,
  );
  let cumulative = 0;
  for (let index = 0; index < words.length; index += 1) {
    cumulative +=
      minSlice + (weights[index]! / totalWeight) * distributableDuration;
    if (elapsed <= cumulative || index === words.length - 1) return index;
  }
  return words.length - 1;
}
