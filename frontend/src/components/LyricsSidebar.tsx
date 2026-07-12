import { useEffect, useState } from "react";
import { BookOpenIcon, XMarkIcon } from "@heroicons/react/16/solid";
import { trackCoverUrl, type LyricsResult } from "../api";
import { useLyricsPanel } from "../context/LyricsPanel";
import { usePlayer, usePlayerTime } from "../context/Player";
import { useAccentFromCover } from "../lib/accent";
import { displayText } from "../lib/format";
import {
  fetchLyricsCached,
  lyricsCacheKey,
  peekLyricsCache,
} from "../lib/lyricsCache";
import CoverArt from "./CoverArt";
import PlayerLyricsLine from "./PlayerLyricsLine";

export default function LyricsSidebar() {
  const { open, setOpen } = useLyricsPanel();
  const { current } = usePlayer();
  const { currentTime, duration } = usePlayerTime();
  const [lyrics, setLyrics] = useState<LyricsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !current) {
      setLyrics(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const key = lyricsCacheKey(current);
    const cached = peekLyricsCache(key);

    if (cached) {
      if (cached.status === "hit") {
        setLyrics(cached.lyrics);
        setError(null);
      } else {
        setLyrics(null);
        setError("No lyrics found");
      }
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    setLyrics(null);

    void fetchLyricsCached(current)
      .then((entry) => {
        if (cancelled) return;
        if (entry.status === "hit") {
          setLyrics(entry.lyrics);
          setError(null);
        } else {
          setLyrics(null);
          setError("No lyrics found");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to fetch lyrics:", err);
        setLyrics(null);
        setError("Failed to load lyrics");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    open,
    current?.id,
    current?.title,
    current?.artist,
    current?.album_title,
    current?.duration_ms,
  ]);

  const trackDurationSeconds =
    current?.duration_ms != null
      ? current.duration_ms / 1000
      : duration > 0
        ? duration
        : 1;

  const coverSrc =
    current && current.has_cover !== false ? trackCoverUrl(current) : null;
  useAccentFromCover(open ? coverSrc : null);

  return (
    <aside
      className="lyrics-sidebar"
      aria-label="Lyrics"
      aria-hidden={!open}
      data-open={open ? "true" : "false"}
    >
      <div className="lyrics-sidebar-bloom" aria-hidden="true">
        {coverSrc ? <img src={coverSrc} alt="" decoding="async" /> : null}
      </div>
      <div className="lyrics-sidebar-scrim" aria-hidden="true" />
      <div className="lyrics-sidebar-head">
        <div className="lyrics-sidebar-title">
          <BookOpenIcon className="size-4" aria-hidden="true" />
          <span>Lyrics</span>
        </div>
        <button
          type="button"
          className="iconbtn"
          aria-label="Close lyrics panel"
          title="Close lyrics"
          onClick={() => setOpen(false)}
        >
          <XMarkIcon className="size-4" />
        </button>
      </div>

      {current ? (
        <div className="lyrics-sidebar-track">
          <CoverArt
            className="lyrics-sidebar-art"
            src={coverSrc}
            seed={current.album_id ?? current.id}
            label={displayText(current.album_title || current.title, "·")}
            size={44}
          />
          <div className="lyrics-sidebar-track-text">
            <div className="lyrics-sidebar-track-title">
              {displayText(current.title)}
            </div>
            <div className="lyrics-sidebar-track-artist">
              {displayText(current.artist, "—")}
              {current.album_title
                ? ` · ${displayText(current.album_title)}`
                : ""}
            </div>
          </div>
        </div>
      ) : (
        <div className="lyrics-sidebar-empty">Nothing playing</div>
      )}

      <div className="lyrics-sidebar-body">
        {!current ? null : (
          <PlayerLyricsLine
            variant="sidebar"
            lyrics={lyrics}
            loading={loading}
            error={error}
            currentTime={currentTime}
            durationSeconds={trackDurationSeconds}
          />
        )}
      </div>
    </aside>
  );
}
