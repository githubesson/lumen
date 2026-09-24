import clsx from "clsx";
import type { ReactNode } from "react";

/** Swaps between two stacked icons: the outgoing one shrinks, blurs and fades
 *  while the incoming one grows in, so the change reads as one morph rather
 *  than a hard cut or a double exposure. */
export default function IconSwap({
  show,
  a,
  b,
  className,
}: {
  show: "a" | "b";
  a: ReactNode;
  b: ReactNode;
  className?: string;
}) {
  const layer =
    "absolute inset-0 grid place-items-center transition-[opacity,scale,filter] duration-200 ease-[var(--ease-out)] motion-reduce:transition-opacity";
  const hidden = "scale-[0.25] opacity-0 blur-[4px] motion-reduce:scale-100 motion-reduce:blur-none";
  return (
    <span className={clsx("relative inline-grid", className)}>
      <span className={clsx(layer, show === "a" ? "scale-100 opacity-100 blur-none" : hidden)} aria-hidden={show !== "a"}>
        {a}
      </span>
      <span className={clsx(layer, show === "b" ? "scale-100 opacity-100 blur-none" : hidden)} aria-hidden={show !== "b"}>
        {b}
      </span>
    </span>
  );
}
