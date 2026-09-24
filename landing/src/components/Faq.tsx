import clsx from "clsx";
import { Plus } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { ISSUES_URL, NGINX_EXAMPLE_URL } from "../lib/site";
import { SectionHeading } from "./ui";

const A = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground">
    {children}
  </a>
);

const QUESTIONS: { q: string; a: ReactNode }[] = [
  {
    q: "What do I need to run it?",
    a: "Any machine that runs Docker: a home server, a NAS, or a small VPS. Docker Compose starts Postgres, the Go backend, and the web app. Your music can live on any folder you mount in.",
  },
  {
    q: "Does it copy or upload my music anywhere?",
    a: "No. Lumen indexes your folders in place and streams straight from disk. Nothing leaves your server unless you share a public link.",
  },
  {
    q: "Can friends and family use it?",
    a: "Yes. Registration is invite-only: as admin you create invites with a role, a use limit, and an expiry. Each person gets their own favorites, playlists, history, and Replay.",
  },
  {
    q: "How do I reach it away from home?",
    a: (
      <>
        Services bind to 127.0.0.1 by default. Put them behind the reverse proxy you already use; there's an{" "}
        <A href={NGINX_EXAMPLE_URL}>nginx example</A> in the repo. Then point the desktop and mobile apps at that URL.
      </>
    ),
  },
  {
    q: "Are the desktop builds signed?",
    a: "Not yet. CI builds are unsigned pre-releases, so Windows SmartScreen and macOS Gatekeeper will warn on first launch, and in-app updates only work on Windows and Linux.",
  },
  {
    q: "Is it really free?",
    a: (
      <>
        Yes. There's no hosted version, no paid tier, and no account with us. If something breaks, <A href={ISSUES_URL}>open an issue</A>.
      </>
    ),
  },
];

function Item({ q, a, open, onToggle }: { q: string; a: ReactNode; open: boolean; onToggle: () => void }) {
  const id = useId();
  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={id}
        className="flex w-full items-center gap-4 py-5 text-left text-[15px] font-medium transition-colors hover:text-foreground/80"
      >
        <span className="flex-1">{q}</span>
        <Plus
          className={clsx(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-[var(--ease-out)]",
            open && "rotate-45",
          )}
        />
      </button>
      <div
        id={id}
        className={clsx(
          "grid transition-[grid-template-rows] duration-300 ease-[var(--ease-out)]",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden" inert={open ? undefined : ""}>
          {/* Fades with the height change so the text doesn't get uncovered
              line by line; leaves faster than it arrives. */}
          <p
            className={clsx(
              "pb-5 pr-8 text-sm leading-relaxed text-muted-foreground transition-[opacity,translate] ease-[var(--ease-out)]",
              open ? "opacity-100 duration-300" : "-translate-y-1 opacity-0 duration-150",
            )}
          >
            {a}
          </p>
        </div>
      </div>
    </div>
  );
}

export default function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section id="faq" className="py-28">
      <div className="mx-auto grid max-w-6xl gap-12 px-5 lg:grid-cols-[1fr_1.6fr]">
        <SectionHeading eyebrow="FAQ" align="left">
          Questions, answered.
        </SectionHeading>
        <div className="reveal border-t border-border">
          {QUESTIONS.map((item, i) => (
            <Item key={item.q} {...item} open={open === i} onToggle={() => setOpen(open === i ? null : i)} />
          ))}
        </div>
      </div>
    </section>
  );
}
