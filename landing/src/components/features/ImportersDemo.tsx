import clsx from "clsx";
import { ArrowDownToLine, CloudDownload } from "lucide-react";
import { useState } from "react";
import { useAutoplay, useInView, useInterval } from "../../lib/hooks";

const SOURCES = ["Filen share", "ArtistGrid", "Lastshare", "Tracker pin"];
const FILES = [
  "Młody West/Ostatni Don.flac",
  "Juice WRLD/Goodbye & Good Riddance (Sessions)/LISTEN TO THIS IF YOU'RE LOST.flac",
  "Lil Uzi Vert/Everywhere.m4a",
  "Destroy Lonely/LOVE TATTOOS.flac",
  "Młody West/Nobu.opus",
];

/** Import sources poll in turn and drop new files into the library. */
export default function ImportersDemo() {
  const [ref, inView] = useInView<HTMLDivElement>();
  const autoplay = useAutoplay(inView);
  const [tick, setTick] = useState(0);

  useInterval(() => setTick((t) => t + 1), 1800, autoplay);

  const polling = tick % SOURCES.length;
  const log = Array.from({ length: 3 }, (_, i) => {
    const n = tick - i;
    return n < 0 ? null : { n, file: FILES[n % FILES.length] };
  }).filter(Boolean) as { n: number; file: string }[];

  return (
    <div ref={ref} className="flex w-full max-w-sm flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        {SOURCES.map((s, i) => (
          <div
            key={s}
            className={clsx(
              "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs transition-colors duration-300",
              i === polling ? "border-foreground/25 bg-brand-soft" : "border-border bg-background/60",
            )}
          >
            <CloudDownload className={clsx("size-3.5", i === polling ? "text-brand" : "text-muted-foreground")} />
            <span className="flex-1 truncate font-medium">{s}</span>
            <span
              className={clsx(
                "size-1.5 rounded-full",
                i === polling ? "animate-pulse bg-brand" : "bg-muted-foreground/40",
              )}
            />
          </div>
        ))}
      </div>
      <div className="h-[92px] overflow-hidden rounded-lg border border-border bg-background/70 p-2.5 font-mono text-[11px] leading-6">
        {log.map(({ n, file }, i) => (
          <div
            key={n}
            className={clsx("flex items-center gap-2 truncate", i === 0 ? "animate-row-in text-foreground" : "text-muted-foreground")}
          >
            <ArrowDownToLine className="size-3 shrink-0 text-success" />
            <span className="truncate">/mnt/music/{file}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
