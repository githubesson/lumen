import { useEffect, useRef, useState } from "react";

interface Props {
  value: number;
  durationMs?: number;
  format?: (n: number) => string;
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export default function AnimatedNumber({
  value,
  durationMs = 600,
  format = (n) => Math.round(n).toLocaleString(),
}: Props) {
  const [display, setDisplay] = useState(prefersReducedMotion() ? value : 0);
  const startedFromRef = useRef(display);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setDisplay(value);
      return;
    }
    const from = startedFromRef.current;
    const to = value;
    if (from === to) return;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / durationMs);
      setDisplay(from + (to - from) * easeOutCubic(t));
      if (t < 1) raf = requestAnimationFrame(step);
      else startedFromRef.current = to;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs]);

  return <>{format(display)}</>;
}
