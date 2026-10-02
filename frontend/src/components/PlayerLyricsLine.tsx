import {
  LYRICS_NOT_FOUND_MESSAGE,
  activeLineIndex,
  activeWordIndexForLine,
  lyricsContent,
} from "@music-library/core/lyrics";
import { memo, useLayoutEffect, useMemo, useRef, type Ref } from "react";
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

/** One synced line. Memoized: per clock tick only the active line's word
 *  highlight changes, so the other lines skip rendering. */
const SyncedLyricLine = memo(function SyncedLyricLine({
  text,
  section,
  state,
  activeWordIndex,
  lineRef,
}: {
  text: string;
  section: boolean;
  state: "active" | "past" | "upcoming";
  activeWordIndex: number | null;
  lineRef: Ref<HTMLParagraphElement> | null;
}) {
  return (
    <p
      ref={lineRef}
      className={
        "player-lyrics-scroll-line " +
        state +
        (section ? " player-lyrics-section" : "")
      }
    >
      {state === "active" && !section
        ? renderLyricWords(text, activeWordIndex)
        : text}
    </p>
  );
});

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

  const content = useMemo(() => lyricsContent(lyrics), [lyrics]);
  const syncedLyrics = content.kind === "synced" ? content.lines : null;
  const plainLines = content.kind === "plain" ? content.lines : null;

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

  if (content.kind === "instrumental") {
    return <p className="player-lyric-status player-lyric-sidebar">Instrumental</p>;
  }

  if (syncedLyrics?.length) {
    return (
      <div ref={scrollRef} className="player-lyrics-scroll">
        {syncedLyrics.map((line, index) => {
          const active = index === currentIndex;
          return (
            <SyncedLyricLine
              key={`${line.time}-${index}`}
              text={line.text}
              section={!!line.section}
              state={active ? "active" : index < currentIndex ? "past" : "upcoming"}
              activeWordIndex={active ? activeWordIndex : null}
              lineRef={active ? activeLineRef : null}
            />
          );
        })}
      </div>
    );
  }

  if (plainLines?.length) {
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
    <p className="player-lyric-status player-lyric-sidebar">{LYRICS_NOT_FOUND_MESSAGE}</p>
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
        {LYRICS_NOT_FOUND_MESSAGE}
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
