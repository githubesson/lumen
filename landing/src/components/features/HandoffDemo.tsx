import clsx from "clsx";
import { Globe, Laptop, Smartphone } from "lucide-react";
import { useState } from "react";
import { useAutoplay, useInView, useInterval } from "../../lib/hooks";
import Equalizer from "../Equalizer";

const DEVICES = [
  { icon: Laptop, name: "MacBook", kind: "Desktop app" },
  { icon: Smartphone, name: "iPhone", kind: "Mobile app" },
  { icon: Globe, name: "Office PC", kind: "Browser" },
];

/** Playback hops between devices; clicking one moves it there. */
export default function HandoffDemo() {
  const [ref, inView] = useInView<HTMLDivElement>();
  const autoplay = useAutoplay(inView);
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

  useInterval(() => setActive((a) => (a + 1) % DEVICES.length), 2600, autoplay && !paused);

  return (
    <div
      ref={ref}
      className="flex w-full max-w-xs flex-col gap-2"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
    >
      {DEVICES.map(({ icon: I, name, kind }, i) => {
        const on = i === active;
        return (
          <button
            key={name}
            type="button"
            onClick={() => setActive(i)}
            className={clsx(
              "flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-[border-color,background-color,scale] duration-300 ease-[var(--ease-out)]",
              on ? "scale-[1.02] border-foreground/25 bg-brand-soft active:scale-100" : "border-border bg-background/60 hover:bg-accent/60 active:scale-[0.97]",
            )}
          >
            <span
              className={clsx(
                "grid size-9 place-items-center rounded-lg transition-colors",
                on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
              )}
            >
              <I className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{name}</span>
              <span className="block text-xs text-muted-foreground">{kind}</span>
            </span>
            {on ? (
              <span className="flex items-center gap-1.5 text-xs font-medium text-brand">
                <Equalizer /> Playing
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">Remote</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
