import clsx from "clsx";

/** Three bouncing bars for the "now playing" row. */
export default function Equalizer({ className }: { className?: string }) {
  return (
    <span className={clsx("flex h-3 items-end gap-[2px] text-brand", className)} aria-hidden>
      {[0, 180, 360].map((d) => (
        <span
          key={d}
          className="h-full w-[3px] origin-bottom animate-eq rounded-full bg-current"
          style={{ animationDelay: `-${d}ms` }}
        />
      ))}
    </span>
  );
}
