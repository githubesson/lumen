import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { useInView, usePrefersReducedMotion } from "../../lib/hooks";
import { byId } from "../../lib/music";
import CoverImg from "../CoverImg";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHAPE = [0.42, 0.55, 0.48, 0.62, 0.7, 0.58, 0.81, 0.93, 0.76, 0.64, 0.71, 1];
const TOTAL = 18_432;
const sum = SHAPE.reduce((a, b) => a + b, 0);
const MONTHS = SHAPE.map((v) => Math.round((v / sum) * TOTAL));
const PEAK = Math.max(...MONTHS);
const topArtist = byId("ostatni-don");

/** Yearly recap: bars grow and the total counts up the first time it's seen.
 *  Hovering (or focusing) a bar shows that month instead. */
export default function ReplayDemo() {
  const [ref, inView] = useInView<HTMLDivElement>();
  const [shown, setShown] = useState(false);
  // True once the reveal has finished; from then on bars only change colour.
  const [grown, setGrown] = useState(false);
  const [minutes, setMinutes] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const started = useRef(false);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (!inView || started.current) return;
    started.current = true;
    const start = performance.now();
    let raf = 0;
    let finished = false;
    const step = (t: number) => {
      setShown(true);
      // Reduced motion lands on the final state in one frame.
      const k = reduced ? 1 : Math.min(1, (t - start) / 1400);
      setMinutes(Math.round(TOTAL * (1 - (1 - k) ** 3)));
      if (k < 1) raf = requestAnimationFrame(step);
      else {
        finished = true;
        setGrown(true);
      }
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      // Interrupted (scrolled away, or StrictMode's remount): run again next time.
      if (!finished) started.current = false;
    };
  }, [inView, reduced]);

  const value = active === null ? minutes : MONTHS[active];

  return (
    <div ref={ref} className="flex w-full max-w-xs flex-col gap-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            {active === null ? "Replay 2026" : `${MONTH_NAMES[active]} 2026`}
          </div>
          <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight">
            {value.toLocaleString("en-US")}
            <span className="ml-1 text-sm font-normal text-muted-foreground">min</span>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-border bg-background/60 py-1 pl-1 pr-2.5">
          <CoverImg src={topArtist.cover} className="size-5 rounded-full" />
          <span className="text-xs font-medium">{topArtist.artist}</span>
        </div>
      </div>

      <div className="flex h-28 items-end gap-1.5" onPointerLeave={() => setActive(null)}>
        {MONTHS.map((m, i) => {
          const on = active === null ? i === MONTHS.length - 1 : i === active;
          return (
            <button
              key={i}
              type="button"
              aria-label={`${MONTH_NAMES[i]}: ${m.toLocaleString("en-US")} minutes`}
              onPointerEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              className="group relative flex h-full flex-1 cursor-default items-end focus-visible:outline-none"
            >
              <span
                className={clsx(
                  "w-full origin-bottom rounded-t-[4px] group-focus-visible:ring-2 group-focus-visible:ring-focus-ring",
                  on ? "bg-foreground" : active === null ? "bg-foreground/20" : "bg-foreground/10",
                )}
                style={{
                  height: `${(m / PEAK) * 100}%`,
                  transform: shown ? "scaleY(1)" : "scaleY(0.04)",
                  // Staggered growth on the first reveal only; after that the
                  // hover highlight is an immediate colour change.
                  transition: grown
                    ? "background-color 150ms ease"
                    : `transform 700ms var(--ease-out) ${i * 45}ms, background-color 150ms ease`,
                }}
              />
              {active === i && (
                <span
                  className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-1.5 py-0.5 font-mono text-[10px] text-background shadow"
                  style={{ bottom: `calc(${(m / PEAK) * 100}% + 6px)` }}
                >
                  {MONTH_NAMES[i].slice(0, 3)} · {m.toLocaleString("en-US")}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>JAN</span>
        <span>DEC</span>
      </div>
    </div>
  );
}
