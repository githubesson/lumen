import clsx from "clsx";
import { Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { formatTime, sliderKey, useAutoplay, useInView, useInterval, usePrefersReducedMotion } from "../../lib/hooks";
import { byId } from "../../lib/music";
import CoverImg from "../CoverImg";
import IconSwap from "../IconSwap";

const URL = "https://music.example.com/s/k3f9Qa";
const PREVIEW_SECONDS = 30;
const track = byId("listen");

/** A chat message types out a share link, the preview unfurls, and its
 *  embedded player starts playing. The play button works. */
export default function ShareDemo() {
  const [ref, inView] = useInView<HTMLDivElement>();
  const autoplay = useAutoplay(inView);
  // Starts unfurled so the card is never blank, then loops.
  const [typed, setTyped] = useState(URL.length);
  // Switching reduced motion on mid-retype jumps straight to the unfurled card.
  const reduced = usePrefersReducedMotion(() => setTyped(URL.length));
  const [wantsPlay, setWantsPlay] = useState(true);
  // Whether the visitor pressed play themselves. Autoplay yields to reduced
  // motion, including when the preference is switched on mid-preview; an
  // explicit press always plays.
  const [userPlayed, setUserPlayed] = useState(false);
  const playing = wantsPlay && (userPlayed || !reduced);
  const [pos, setPos] = useState(9);
  const unfurled = typed >= URL.length;

  // Type the link, hold while the preview plays (or sits paused), and start
  // over a moment after it finishes.
  // Held while keyboard focus is inside the demo: restarting would make the
  // embed inert and drop the focused control.
  const [focusWithin, setFocusWithin] = useState(false);

  useEffect(() => {
    if (!autoplay || focusWithin || (unfurled && pos < PREVIEW_SECONDS)) return;
    const id = window.setTimeout(
      () => {
        if (unfurled) {
          setTyped(0);
          setPos(0);
          setUserPlayed(false);
        } else {
          setTyped(typed + 1);
          if (typed + 1 >= URL.length) setWantsPlay(true);
        }
      },
      unfurled ? 2200 : typed === 0 ? 700 : 32,
    );
    return () => window.clearTimeout(id);
  }, [autoplay, focusWithin, typed, unfurled, pos]);

  useInterval(
    () =>
      setPos((p) => {
        const next = Math.min(PREVIEW_SECONDS, p + 0.25);
        if (next >= PREVIEW_SECONDS) setWantsPlay(false);
        return next;
      }),
    250,
    inView && unfurled && playing,
  );

  return (
    <div
      ref={ref}
      className="flex w-full max-w-sm gap-3"
      onFocus={() => setFocusWithin(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
      }}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium">MV</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[13px]">
          <span className="font-medium">mira</span>
          <span className="text-[11px] text-muted-foreground">Today at 21:04</span>
        </div>
        <div className="mt-0.5 text-[13px] text-foreground/90">this one's been on repeat all week</div>
        <div className="h-5 truncate text-[13px] text-foreground underline decoration-foreground/30 underline-offset-2">
          {URL.slice(0, typed)}
          {!unfurled && <span className="ml-px inline-block h-3.5 w-px translate-y-0.5 animate-blink bg-foreground" />}
        </div>

        <div
          className={clsx(
            "mt-2 origin-top-left rounded-md border-l-4 border-foreground/25 bg-muted/60 p-3 transition-[opacity,scale] duration-300 ease-[var(--ease-out)] dark:bg-black/25",
            unfurled ? "scale-100 opacity-100" : "scale-[0.97] opacity-0",
          )}
          // Hidden between loops: keep its controls out of the tab order and
          // the accessibility tree while it fades.
          inert={unfurled ? undefined : ""}
        >
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] text-muted-foreground">Lumen</div>
              <div className="mt-1 text-xs font-medium">{track.artist}</div>
              <div className="mt-0.5 line-clamp-2 text-[13px] font-semibold leading-snug">
                {track.title}
              </div>
              <div className="mt-1 truncate text-xs text-muted-foreground">Goodbye &amp; Good Riddance (Sessions)</div>
            </div>
            <CoverImg src={track.cover} className="size-[72px] rounded" />
          </div>

          <div className="mt-3 flex items-center gap-2.5 rounded-md bg-background/70 p-1.5 pr-3">
            <button
              type="button"
              onClick={() => {
                if (pos >= PREVIEW_SECONDS) setPos(0);
                setUserPlayed(true);
                setWantsPlay(!playing);
              }}
              className="press grid size-7 shrink-0 place-items-center rounded-full bg-foreground text-background"
              aria-label={playing ? "Pause preview" : "Play preview"}
            >
              <IconSwap
                show={playing ? "a" : "b"}
                a={<Pause className="size-3 fill-current" />}
                b={<Play className="size-3 translate-x-px fill-current" />}
                className="size-3"
              />
            </button>
            <div
              role="slider"
              tabIndex={0}
              aria-label="Preview position"
              aria-valuemin={0}
              aria-valuemax={PREVIEW_SECONDS}
              aria-valuenow={Math.round(pos)}
              aria-valuetext={`${formatTime(pos)} of ${formatTime(PREVIEW_SECONDS)}`}
              onKeyDown={(e) => sliderKey(e, pos / PREVIEW_SECONDS, 1 / PREVIEW_SECONDS, (f) => setPos(f * PREVIEW_SECONDS))}
              className="relative h-1 flex-1 cursor-pointer overflow-hidden rounded-full bg-foreground/15 focus-visible:outline-2 focus-visible:outline-offset-4"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setPos(((e.clientX - r.left) / r.width) * PREVIEW_SECONDS);
              }}
            >
              {/* Full-width fill slid in from the left: transform, not width,
                  and linear because it's constant progress. */}
              <div
                className="h-full rounded-full bg-foreground transition-transform duration-250 ease-linear"
                style={{ transform: `translateX(${(pos / PREVIEW_SECONDS) * 100 - 100}%)` }}
              />
            </div>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {formatTime(pos)} / {formatTime(PREVIEW_SECONDS)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
