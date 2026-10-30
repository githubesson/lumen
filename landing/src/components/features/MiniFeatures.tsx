import clsx from "clsx";
import { Check, Search, UploadCloud } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useAutoplay, useInView } from "../../lib/hooks";
import { byId } from "../../lib/music";
import CoverImg from "../CoverImg";
import { DiscordIcon } from "../icons";

// Small tiles are still by default, and each one plays a single small step of
// its feature on hover, via the `play:` variant. Touch screens can't hover, so
// there a tile on screen plays its step and rewinds on a slow loop instead.
const MOVE = "transition-[translate,opacity] duration-300 ease-[var(--ease-in-out)] motion-reduce:transition-none";

const CAN_HOVER = window.matchMedia("(hover: hover)").matches;
const PLAY_MS = 2200;

function Tile({ title, line, children, stagger }: { title: string; line: string; children: ReactNode; stagger: number }) {
  const [ref, inView] = useInView<HTMLElement>();
  const autoplay = useAutoplay(inView) && !CAN_HOVER;
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!autoplay) return;
    // First step lands a moment after the tile scrolls into view; the stagger
    // keeps neighbouring tiles from flipping in lockstep.
    let id = 0;
    const flip = () => {
      setPlaying((p) => !p);
      id = window.setTimeout(flip, PLAY_MS);
    };
    id = window.setTimeout(flip, 700 + stagger * 4);
    return () => window.clearTimeout(id);
  }, [autoplay, stagger]);

  return (
    <article
      ref={ref}
      data-play={autoplay && playing ? "" : undefined}
      className="card-surface group flex flex-col overflow-hidden rounded-2xl"
    >
      <div className="relative flex h-36 items-center justify-center overflow-hidden px-6 pt-5" aria-hidden>
        {children}
      </div>
      <div className="px-6 pb-5 pt-4">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{line}</p>
      </div>
    </article>
  );
}

const FORMATS = ["FLAC", "MP3", "AAC", "Opus", "Ogg", "WAV", "M4A", "WebM"];

function Formats() {
  return (
    <div className="grid w-full max-w-60 grid-cols-4 gap-1.5">
      {FORMATS.map((f, i) => (
        <span
          key={f}
          className="flex h-8 items-center justify-center rounded-md border border-border bg-background/70 font-mono text-[11px] font-medium transition-[translate,border-color] duration-200 ease-[var(--ease-out)] play:-translate-y-0.5 play:border-foreground/20 motion-reduce:play:translate-y-0"
          style={{ transitionDelay: `${i * 25}ms` }}
        >
          {f}
        </span>
      ))}
    </div>
  );
}

// Lyric lines are drawn as bars: the point is the sync, not the words.
const LYRIC_LINES = [
  { t: "0:41.2", w: "w-[70%]" },
  { t: "0:44.8", w: "w-[85%]" },
  { t: "0:48.1", w: "w-[60%]" },
  { t: "0:51.9", w: "w-[78%]" },
];

function Lyrics() {
  return (
    <div className="relative w-full max-w-64">
      {/* Current-line highlight moves down one line on hover. */}
      <div className={clsx("absolute inset-x-0 top-7 h-7 rounded-md bg-brand-soft play:translate-y-7", MOVE)} />
      {LYRIC_LINES.map((l, i) => (
        <div key={l.t} className="relative flex h-7 items-center gap-3 px-2">
          <span className="w-10 font-mono text-[11px] text-muted-foreground">{l.t}</span>
          <span
            className={clsx(
              "h-2 rounded-full transition-colors duration-300",
              l.w,
              i === 1 ? "bg-foreground play:bg-foreground/20" : i === 2 ? "bg-foreground/20 play:bg-foreground" : "bg-foreground/20",
            )}
          />
        </div>
      ))}
    </div>
  );
}

function Scrobble() {
  const t = byId("love-tattoos");
  return (
    <div className="w-full max-w-64">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-background/70 p-2">
        <CoverImg src={t.cover} className="size-9 rounded" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{t.title}</div>
          <div className="truncate text-[11px] text-muted-foreground">{t.artist}</div>
        </div>
        {/* Both labels share one grid cell, so the clip box is as wide as the
            wider of the two and neither gets cut off. */}
        <span className="grid h-5 items-center justify-items-end overflow-hidden text-[11px] font-medium">
          <span
            className={clsx(
              "col-start-1 row-start-1 text-muted-foreground play:-translate-y-5 play:opacity-0",
              MOVE,
            )}
          >
            now playing
          </span>
          <span
            className={clsx(
              "col-start-1 row-start-1 flex translate-y-5 items-center gap-1 opacity-0 play:translate-y-0 play:opacity-100",
              MOVE,
            )}
          >
            <Check className="size-3 shrink-0 text-success" /> scrobbled
          </span>
        </span>
      </div>
      <div className="mt-2 flex justify-between gap-2 whitespace-nowrap px-1 font-mono text-[11px] text-muted-foreground">
        <span>last.fm/user/you</span>
        <span className="tabular-nums">
          12,84<span className="inline-grid overflow-hidden align-bottom">
            <span className={clsx("col-start-1 row-start-1 play:-translate-y-full play:opacity-0", MOVE)}>7</span>
            <span className={clsx("col-start-1 row-start-1 translate-y-full opacity-0 play:translate-y-0 play:opacity-100", MOVE)}>8</span>
          </span>{" "}
          scrobbles
        </span>
      </div>
    </div>
  );
}

function Presence() {
  const t = byId("everywhere");
  return (
    <div className="w-full max-w-64 rounded-lg bg-muted/60 p-3 dark:bg-black/25">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <DiscordIcon className="size-3" /> Listening to Lumen
      </div>
      <div className="mt-2 flex items-center gap-3">
        <CoverImg src={t.cover} className="size-12 rounded-md" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold">{t.title}</div>
          <div className="truncate text-[11px] text-muted-foreground">by {t.artist}</div>
          <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <span>1:12</span>
            <span className="h-1 flex-1 overflow-hidden rounded-full bg-foreground/15">
              {/* Width, not a translated full-width fill: the fill's box stays inside
                  the track, so it doesn't overlap the time labels. */}
              <span className="block h-full w-[38%] rounded-full bg-foreground transition-[width] duration-[1200ms] ease-linear play:w-[52%] motion-reduce:transition-none" />
            </span>
            <span>3:08</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Palette() {
  const results = [
    { t: byId("vamp-city"), kind: "Track" },
    { t: { ...byId("vamp-city"), title: "Ken Carson", artist: "" }, kind: "Artist" },
  ];
  return (
    <div className="w-full max-w-64 overflow-hidden rounded-lg border border-border bg-background/80 shadow-sm">
      <div className="flex h-8 items-center gap-2 border-b border-border px-2.5 text-xs">
        <Search className="size-3.5 text-muted-foreground" />
        <span>
          vamp<span className="ml-px inline-block h-3 w-px translate-y-0.5 animate-blink bg-foreground" />
        </span>
        <kbd className="ml-auto rounded border border-border px-1 font-mono text-[11px] text-muted-foreground">⌘K</kbd>
      </div>
      <div className="relative p-1">
        {/* Selection moves to the next result on hover, like pressing ↓. */}
        <div className={clsx("absolute inset-x-1 top-1 h-9 rounded-md bg-accent play:translate-y-9", MOVE)} />
        {results.map(({ t, kind }) => (
          <div key={kind} className="relative flex h-9 items-center gap-2.5 px-2">
            <CoverImg src={t.cover} className={clsx("size-6", kind === "Artist" ? "rounded-full" : "rounded")} />
            <span className="min-w-0 flex-1 truncate text-xs font-medium">{t.title}</span>
            <span className="text-[11px] text-muted-foreground">{kind}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Upload() {
  // Only title and artist are shown here, so no cover is needed.
  const t = { title: "Undercover", artist: "Coldlone" };
  return (
    <div className="w-full max-w-64 space-y-2">
      <div className="rounded-lg border border-border bg-background/70 p-2.5">
        <div className="flex items-center gap-2 text-xs">
          <UploadCloud className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{t.title}.flac</span>
          <span className="relative grid h-4 w-9 place-items-end overflow-hidden font-mono text-[11px] text-muted-foreground">
            <span className={clsx("play:-translate-y-4 play:opacity-0", MOVE)}>64%</span>
            <span className={clsx("absolute right-0 top-4 opacity-0 play:-translate-y-4 play:opacity-100", MOVE)}>
              <Check className="size-3 text-success" />
            </span>
          </span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-foreground/15">
          <div className="h-full w-full -translate-x-[36%] rounded-full bg-foreground transition-transform duration-700 ease-[var(--ease-out)] play:translate-x-0 motion-reduce:transition-none" />
        </div>
      </div>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-background/70 px-2.5 py-2 text-[11px]">
        <span className="text-muted-foreground">Title</span>
        <span className="truncate rounded bg-muted/70 px-1.5 py-0.5">{t.title}</span>
        <span className="text-muted-foreground">Artist</span>
        <span className="truncate rounded bg-muted/70 px-1.5 py-0.5">{t.artist}</span>
      </div>
    </div>
  );
}

const TILES = [
  { title: "Plays what you have", line: "FLAC, MP3, AAC, Opus, Ogg and WAV, served as-is", body: <Formats /> },
  { title: "Lyrics", line: "Time-synced when available, in a side panel", body: <Lyrics /> },
  { title: "Last.fm scrobbling", line: "Per user, now-playing and scrobbles", body: <Scrobble /> },
  { title: "Discord Rich Presence", line: "“Listening to Lumen”, with cover art", body: <Presence /> },
  { title: "Command palette", line: "⌘K to jump to any track, album, or artist", body: <Palette /> },
  { title: "Uploads & tag editing", line: "From the browser or your phone", body: <Upload /> },
];

export default function MiniFeatures() {
  return (
    <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {TILES.map((t, i) => (
        <Tile key={t.title} title={t.title} line={t.line} stagger={(i % 3) * 60}>
          {t.body}
        </Tile>
      ))}
    </div>
  );
}
