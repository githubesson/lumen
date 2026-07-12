import { useLayoutEffect, useMemo, useRef } from "react";
import type { LyricsResult } from "../api";
import IosSpinner from "./IosSpinner";

interface ParsedLyricLine {
  time: number;
  text: string;
}

function parseSyncedLyrics(text: string): ParsedLyricLine[] {
  const lines: ParsedLyricLine[] = [];

  for (const rawLine of text.split("\n")) {
    const lyricText = rawLine.replace(/\[[^\]]+\]/g, "").trim();
    const timestamps = [
      ...rawLine.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g),
    ];

    for (const stamp of timestamps) {
      const minutes = Number(stamp[1]);
      const seconds = Number(stamp[2]);
      const fractionRaw = stamp[3] ?? "0";
      const fraction = Number(`0.${fractionRaw.padEnd(3, "0")}`);
      const time = minutes * 60 + seconds + fraction;

      if (Number.isFinite(time) && lyricText) {
        lines.push({ time, text: lyricText });
      }
    }
  }

  return lines.sort((a, b) => a.time - b.time);
}

function parsePlainLyrics(text?: string): string[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, "").trim())
    .filter(Boolean);
}

function activeLineIndex(
  syncedLyrics: ParsedLyricLine[],
  elapsed: number,
): number {
  let index = -1;
  for (let i = 0; i < syncedLyrics.length; i += 1) {
    if (syncedLyrics[i]!.time <= elapsed) {
      index = i;
    } else {
      break;
    }
  }
  return index;
}

function activeWordIndexForLine(
  currentLine: ParsedLyricLine,
  nextLine: ParsedLyricLine | undefined,
  elapsed: number,
  trackDurationSeconds: number,
): number | null {
  const lineStart = currentLine.time;
  const estimatedTailDuration = Math.min(
    8,
    Math.max(1.2, currentLine.text.replace(/\s+/g, "").length * 0.085),
  );
  const lineEnd = nextLine
    ? Math.max(nextLine.time, lineStart + 0.2)
    : Math.max(
        Math.min(trackDurationSeconds, lineStart + estimatedTailDuration),
        lineStart + 0.2,
      );

  const lineDuration = Math.max(0.2, lineEnd - lineStart);
  const lineElapsed = Math.min(lineDuration, Math.max(0, elapsed - lineStart));

  const words = currentLine.text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;

  const minSlice = Math.min(0.14, lineDuration / words.length);
  const baseDuration = minSlice * words.length;
  const distributableDuration = Math.max(0, lineDuration - baseDuration);

  const weights = words.map((word) => {
    const cleaned = word.replace(/[^A-Za-z0-9]/g, "");
    return Math.max(1, cleaned.length || word.length);
  });
  const totalWeight = Math.max(
    1,
    weights.reduce((sum, value) => sum + value, 0),
  );

  let cumulative = 0;
  let activeWordIndex = 0;
  for (let i = 0; i < words.length; i += 1) {
    const weightedExtra = (weights[i]! / totalWeight) * distributableDuration;
    cumulative += minSlice + weightedExtra;
    if (lineElapsed <= cumulative || i === words.length - 1) {
      activeWordIndex = i;
      break;
    }
  }

  return activeWordIndex;
}

function renderLyricWords(text: string, activeWordIndex: number | null) {
  const tokens = text.split(/(\s+)/);
  let wordIndex = 0;

  return tokens.map((token, i) => {
    if (!token) return null;
    if (/^\s+$/.test(token)) {
      return <span key={`space-${i}`}>{token}</span>;
    }

    const currentWordIndex = wordIndex;
    wordIndex += 1;

    let stateClass = "player-lyric-word";
    if (activeWordIndex !== null) {
      if (currentWordIndex < activeWordIndex) {
        stateClass += " player-lyric-word-past";
      } else if (currentWordIndex === activeWordIndex) {
        stateClass += " player-lyric-word-active";
      } else {
        stateClass += " player-lyric-word-upcoming";
      }
    }

    return (
      <span key={`word-${i}`} className={stateClass}>
        {token}
      </span>
    );
  });
}

function SidebarLyricsView({
  lyrics,
  currentTime,
  durationSeconds,
}: {
  lyrics: LyricsResult;
  currentTime: number;
  durationSeconds: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeLineRef = useRef<HTMLParagraphElement>(null);
  const lastScrolledLineRef = useRef(-1);

  const syncedLyrics = useMemo(() => {
    if (!lyrics.syncedLyrics) return null;
    const parsed = parseSyncedLyrics(lyrics.syncedLyrics);
    return parsed.length > 0 ? parsed : null;
  }, [lyrics.syncedLyrics]);

  const plainLines = useMemo(
    () => parsePlainLyrics(lyrics.plainLyrics ?? undefined),
    [lyrics.plainLyrics],
  );

  const currentIndex = useMemo(() => {
    if (!syncedLyrics?.length) return -1;
    return activeLineIndex(syncedLyrics, currentTime);
  }, [syncedLyrics, currentTime]);

  const activeWordIndex = useMemo(() => {
    if (!syncedLyrics?.length || currentIndex < 0) return null;
    const currentLine = syncedLyrics[currentIndex];
    if (!currentLine) return null;
    return activeWordIndexForLine(
      currentLine,
      syncedLyrics[currentIndex + 1],
      currentTime,
      Math.max(1, durationSeconds),
    );
  }, [syncedLyrics, currentIndex, currentTime, durationSeconds]);

  useLayoutEffect(() => {
    if (!scrollRef.current || !activeLineRef.current || currentIndex < 0) return;
    if (currentIndex === lastScrolledLineRef.current) return;

    const container = scrollRef.current;
    const line = activeLineRef.current;
    const containerHeight = container.clientHeight;
    const lineTop = line.offsetTop;
    const lineHeight = line.clientHeight;

    container.scrollTo({
      top: lineTop - containerHeight / 2 + lineHeight / 2,
      behavior: "smooth",
    });
    lastScrolledLineRef.current = currentIndex;
  }, [currentIndex]);

  useLayoutEffect(() => {
    lastScrolledLineRef.current = -1;
  }, [lyrics.syncedLyrics, lyrics.plainLyrics]);

  if (lyrics.instrumental) {
    return <p className="player-lyric-status player-lyric-sidebar">Instrumental</p>;
  }

  if (syncedLyrics?.length) {
    return (
      <div ref={scrollRef} className="player-lyrics-scroll">
        {syncedLyrics.map((line, index) => {
          const state =
            index === currentIndex
              ? "active"
              : index < currentIndex
                ? "past"
                : "upcoming";

          return (
            <p
              key={`${line.time}-${index}`}
              ref={index === currentIndex ? activeLineRef : null}
              className={"player-lyrics-scroll-line " + state}
            >
              {index === currentIndex
                ? renderLyricWords(line.text, activeWordIndex)
                : line.text}
            </p>
          );
        })}
      </div>
    );
  }

  if (plainLines.length) {
    return (
      <div className="player-lyrics-scroll player-lyrics-scroll-plain">
        {plainLines.map((line, index) => (
          <p key={index} className="player-lyrics-scroll-line">
            {line}
          </p>
        ))}
      </div>
    );
  }

  return (
    <p className="player-lyric-status player-lyric-sidebar">No lyrics found</p>
  );
}

export default function PlayerLyricsLine({
  lyrics,
  loading,
  error,
  currentTime,
  durationSeconds,
  variant = "compact",
}: {
  lyrics: LyricsResult | null;
  loading: boolean;
  error: string | null;
  currentTime: number;
  durationSeconds: number;
  variant?: "compact" | "panel" | "sidebar";
}) {
  if (loading) {
    return (
      <div className="player-lyrics-spinner-wrap" aria-busy="true">
        <IosSpinner label="Loading lyrics" />
      </div>
    );
  }

  if (error) {
    return (
      <p
        className={
          "player-lyric-status player-lyric-status-error player-lyric-" +
          variant
        }
      >
        {error}
      </p>
    );
  }

  if (!lyrics) {
    return (
      <p className={"player-lyric-status player-lyric-" + variant}>
        No lyrics found
      </p>
    );
  }

  if (variant === "sidebar") {
    return (
      <SidebarLyricsView
        lyrics={lyrics}
        currentTime={currentTime}
        durationSeconds={durationSeconds}
      />
    );
  }

  return (
    <p className={"player-lyric-status player-lyric-" + variant}>
      Lyrics view unavailable
    </p>
  );
}
