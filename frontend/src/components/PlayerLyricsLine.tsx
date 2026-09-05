import {
  parseSyncedLyrics,
  parsePlainLyrics,
  activeLineIndex,
  activeWordIndexForLine,
} from "@music-library/core/lyrics";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { LyricsResult } from "../api";
import IosSpinner from "./IosSpinner";

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
    if (!currentLine || currentLine.section) return null;
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
              className={
                "player-lyrics-scroll-line " +
                state +
                (line.section ? " player-lyrics-section" : "")
              }
            >
              {index === currentIndex && !line.section
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
          <p
            key={index}
            className={
              "player-lyrics-scroll-line" +
              (line.section ? " player-lyrics-section" : "")
            }
          >
            {line.text}
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
