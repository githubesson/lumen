import clsx from "clsx";
import type { ReactNode } from "react";
import { spotlight } from "../../lib/hooks";
import { delay } from "../ui";

export default function FeatureCard({
  title,
  line,
  children,
  className,
  stagger = 0,
}: {
  title: string;
  line: string;
  children: ReactNode;
  className?: string;
  stagger?: number;
}) {
  return (
    <article
      onPointerMove={spotlight}
      style={delay(stagger)}
      className={clsx(
        "card-surface spotlight reveal group flex flex-col overflow-hidden rounded-2xl",
        className,
      )}
    >
      <div className="relative flex min-h-56 flex-1 items-center justify-center overflow-hidden p-6">{children}</div>
      <div className="border-t border-border/70 px-6 py-5">
        <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
        {/* Two lines reserved, so the divider above lines up across a row even
            when one card's line wraps and its neighbour's doesn't. */}
        <p className="mt-1 min-h-[2lh] text-sm text-muted-foreground">{line}</p>
      </div>
    </article>
  );
}

/** Deterministic pseudo-random numbers, so demos render the same every time. */
export function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
