import clsx from "clsx";
import { UserPlus } from "lucide-react";
import { useState } from "react";
import { useAutoplay, useInView, useInterval } from "../../lib/hooks";
import { TRACKS } from "../../lib/music";
import CoverImg from "../CoverImg";

const PEOPLE = [
  { initials: "AL", name: "alex" },
  { initials: "MV", name: "mira" },
  { initials: "KC", name: "kilo" },
];
const VISIBLE = 4;
const ROW_H = 48;
const MOSAIC = ["ostatni-don", "listen", "love-tattoos", "everywhere"].map((id) => TRACKS.find((t) => t.id === id)!.cover);

// Each row is a track added by someone; `key` counts up so new rows animate in.
type Row = { key: number; track: number; person: number };
const rowFor = (key: number): Row => ({ key, track: key % TRACKS.length, person: (key * 2 + 1) % PEOPLE.length });

function Avatar({ person, className }: { person: number; className?: string }) {
  return (
    <span
      className={clsx(
        "grid place-items-center rounded-full bg-muted font-semibold text-foreground/80 ring-2 ring-card",
        className,
      )}
      title={PEOPLE[person].name}
    >
      {PEOPLE[person].initials}
    </span>
  );
}

/** A shared playlist where collaborators keep adding tracks. */
export default function PlaylistDemo() {
  const [ref, inView] = useInView<HTMLDivElement>();
  const autoplay = useAutoplay(inView);
  const [rows, setRows] = useState<Row[]>(() => Array.from({ length: VISIBLE }, (_, i) => rowFor(VISIBLE - 1 - i)));

  // One row more than fits: the new row grows in at the top and pushes the
  // oldest out past the clipped bottom edge, so the card never jumps.
  useInterval(() => setRows((r) => [rowFor(r[0].key + 1), ...r].slice(0, VISIBLE + 1)), 2600, autoplay);

  return (
    <div ref={ref} className="w-full max-w-md">
      <div className="flex items-center gap-3.5">
        <div className="grid size-14 shrink-0 grid-cols-2 overflow-hidden rounded-md shadow-sm">
          {MOSAIC.map((src) => (
            <img key={src} src={src} alt="" className="size-full object-cover" />
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Collaborative</div>
          <div className="truncate text-base font-semibold tracking-tight">Late drives</div>
          <div className="text-xs tabular-nums text-muted-foreground">{20 + rows[0].key} tracks</div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex -space-x-1.5">
            {PEOPLE.map((p, i) => (
              <Avatar key={p.name} person={i} className="size-7 text-[10px]" />
            ))}
          </div>
          <span className="hidden h-7 items-center gap-1 rounded-md border border-border px-2 text-xs sm:flex">
            <UserPlus className="size-3.5" /> Invite
          </span>
        </div>
      </div>

      <ul className="mt-4 flex flex-col overflow-hidden" style={{ height: ROW_H * VISIBLE }}>
        {rows.map((row, i) => {
          const track = TRACKS[row.track];
          const fresh = i === 0 && row.key >= VISIBLE;
          return (
            <li key={row.key} className={clsx("grid shrink-0", fresh && "animate-row-grow")}>
              <div className="overflow-hidden">
                <div
                  className={clsx("flex h-12 shrink-0 items-center gap-3 rounded-lg px-2 text-[13px]", fresh && "animate-row-flash")}
                >
                  <CoverImg src={track.cover} className="size-9 rounded" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{track.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{track.artist}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="tabular-nums">{i === 0 ? "just now" : `${i * 3}m ago`}</span>
                    <Avatar person={row.person} className="size-6 text-[9px]" />
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
