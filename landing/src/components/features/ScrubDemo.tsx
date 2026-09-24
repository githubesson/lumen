import clsx from "clsx";
import { useMemo, useRef, useState } from "react";
import { formatTime, sliderKey, useAutoplay, useInView, useInterval } from "../../lib/hooks";
import { seeded } from "./FeatureCard";

const BARS = 88;
const DURATION = 214;
const FILE_BYTES = 38_412_907; // a ~3.5 min FLAC

/** Scrub anywhere: hover to preview, click to seek; the request line shows
 *  the byte range the player would ask the server for. */
export default function ScrubDemo() {
  const [ref, inView] = useInView<HTMLDivElement>();
  const autoplay = useAutoplay(inView);
  const [pos, setPos] = useState(0.18);
  const [hover, setHover] = useState<number | null>(null);
  const [latency, setLatency] = useState(11);
  const bars = useMemo(() => {
    const r = seeded(7);
    return Array.from({ length: BARS }, (_, i) => {
      const env = 0.45 + 0.55 * Math.sin((i / BARS) * Math.PI) ** 0.6;
      return Math.max(0.12, env * (0.35 + r() * 0.65));
    });
  }, []);
  const wave = useRef<HTMLDivElement>(null);

  useInterval(() => setPos((p) => (p + 0.0025) % 1), 100, autoplay && hover === null);

  const fractionAt = (clientX: number) => {
    const r = wave.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };

  const shown = hover ?? pos;
  const offset = Math.floor(shown * FILE_BYTES);

  return (
    <div ref={ref} className="flex w-full max-w-xl flex-col gap-5">
      <div
        ref={wave}
        className="relative flex h-28 cursor-pointer touch-none items-center gap-[3px] rounded-md focus-visible:outline-2 focus-visible:outline-offset-4"
        onPointerMove={(e) => setHover(fractionAt(e.clientX))}
        onPointerLeave={() => setHover(null)}
        onPointerDown={(e) => {
          setPos(fractionAt(e.clientX));
          setLatency(8 + Math.floor(Math.random() * 9));
        }}
        onKeyDown={(e) => sliderKey(e, pos, 5 / DURATION, setPos)}
        tabIndex={0}
        role="slider"
        aria-label="Demo track position"
        aria-valuemin={0}
        aria-valuemax={DURATION}
        aria-valuenow={Math.round(pos * DURATION)}
        aria-valuetext={`${formatTime(pos * DURATION)} of ${formatTime(DURATION)}`}
      >
        {bars.map((h, i) => {
          const f = i / BARS;
          return (
            <span
              key={i}
              className={clsx(
                "flex-1 rounded-full transition-colors duration-150",
                f <= pos ? "bg-brand" : hover !== null && f <= hover ? "bg-foreground/40" : "bg-foreground/15",
              )}
              style={{ height: `${h * 100}%` }}
            />
          );
        })}
        {/* Playhead: a full-width layer translated by a percentage of its own
            width, so it moves on the compositor. It follows the pointer
            directly while scrubbing, and glides linearly between autoplay
            ticks. */}
        <span
          className="pointer-events-none absolute inset-0"
          style={{
            transform: `translateX(${shown * 100}%)`,
            transition: hover === null ? "transform 100ms linear" : "none",
          }}
        >
          <span className="absolute inset-y-0 left-0 w-px bg-foreground">
            <span className="absolute -top-6 left-1/2 -translate-x-1/2 rounded bg-foreground px-1.5 py-0.5 font-mono text-[10px] text-background">
              {formatTime(shown * DURATION)}
            </span>
          </span>
        </span>
      </div>

      <div className="rounded-lg border border-border bg-background/70 p-3 font-mono text-[11px] leading-5 text-muted-foreground sm:text-xs">
        <div>
          <span className="text-brand">GET</span> /api/tracks/482/stream
        </div>
        <div>
          Range: <span className="text-foreground">bytes={offset}-</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2">
          <span className="flex items-center gap-2 whitespace-nowrap text-foreground">
            <span className="size-1.5 rounded-full bg-success" />
            206 Partial Content
          </span>
          <span className="whitespace-nowrap">· {latency}ms · no full-file buffering</span>
        </div>
      </div>
    </div>
  );
}
