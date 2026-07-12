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
  FadeIn,
  FadeOut,
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
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 20 }}>
        <Text selectable style={{ color: theme.color.fgMuted, textAlign: "center" }}>
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
    active.value = withTiming(state === "active" ? 1 : 0, { duration: 240 });
    past.value = withTiming(state === "past" ? 1 : 0, { duration: 240 });
  }, [active, past, state]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: active.value
      ? 1
      : past.value
        ? 0.3
        : 0.48,
    transform: [{ scale: active.value ? 1 : past.value ? 0.975 : 0.99 }],
  }));

  return (
    <Animated.View onLayout={onLayout} style={[{ transformOrigin: "left center" }, animatedStyle]}>
      <Text
        selectable
        style={{
          color: line.section
            ? theme.color.accent
            : state === "active"
              ? theme.color.fg
              : theme.color.fgMuted,
          fontSize: line.section ? 12 : state === "active" ? 19 : 18,
          fontWeight: line.section ? "700" : state === "active" ? "600" : "500",
          lineHeight: line.section ? 18 : 27,
          letterSpacing: line.section ? 0.6 : 0,
          textTransform: line.section ? "uppercase" : "none",
        }}
      >
        {state === "active" && !line.section
          ? renderWords(line.text, activeWordIndex, theme.color.fg, theme.color.fgMuted)
          : line.text}
      </Text>
    </Animated.View>
  );
}

function renderWords(text: string, activeIndex: number | null, activeColor: string, mutedColor: string) {
  const tokens = text.split(/(\s+)/);
  let word = 0;
  return tokens.map((token, index) => {
    if (/^\s+$/.test(token)) return token;
    const current = word++;
    const color =
      activeIndex === null
        ? mutedColor
        : current < activeIndex
          ? `${activeColor}B8`
          : current === activeIndex
            ? activeColor
            : `${activeColor}70`;
    return (
      <Text key={`${index}-${token}`} style={{ color, fontWeight: current === activeIndex ? "700" : "600" }}>
        {token}
      </Text>
    );
  });
}

function parseSyncedLyrics(text?: string | null): SyncedLine[] {
  if (!text) return [];
  const lines: SyncedLine[] = [];
  for (const rawLine of text.split("\n")) {
    const lyricText = rawLine
      .replace(/\[\d{1,3}:\d{2}(?:\.\d{1,3})?\]/g, "")
      .trim();
    for (const stamp of rawLine.matchAll(/\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g)) {
      const time = Number(stamp[1]) * 60 + Number(stamp[2]) + Number(`0.${(stamp[3] ?? "0").padEnd(3, "0")}`);
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
  const estimatedTail = Math.min(8, Math.max(1.2, line.text.replace(/\s+/g, "").length * 0.085));
  const end = next ? Math.max(next.time, line.time + 0.2) : Math.max(Math.min(duration, line.time + estimatedTail), line.time + 0.2);
  const lineDuration = Math.max(0.2, end - line.time);
  const elapsed = Math.min(lineDuration, Math.max(0, currentTime - line.time));
  const weights = words.map((word) => Math.max(1, word.replace(/[^\p{L}\p{N}]/gu, "").length || word.length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let cumulative = 0;
  for (let index = 0; index < words.length; index += 1) {
    cumulative += (weights[index]! / totalWeight) * lineDuration;
    if (elapsed <= cumulative || index === words.length - 1) return index;
  }
  return words.length - 1;
}
