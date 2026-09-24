import clsx from "clsx";
import {
  Check,
  Copy,
  Database,
  FolderOpen,
  Globe,
  KeyRound,
  Laptop,
  Link2,
  Lock,
  Server,
  Smartphone,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useCopy, useInView, usePrefersReducedMotion } from "../lib/hooks";
import { INSTALL_STEPS, README_URL } from "../lib/site";
import IconSwap from "./IconSwap";
import { ButtonLink, SectionHeading, delay } from "./ui";

const OUTPUT = [
  { name: "postgres", detail: "healthy" },
  { name: "backend", detail: "listening on 127.0.0.1:8080" },
  { name: "frontend", detail: "listening on 127.0.0.1:8081" },
];

function Terminal() {
  const [ref, inView] = useInView<HTMLDivElement>();
  const { copied, copy } = useCopy();
  // Container lines appear one by one the first time the terminal is seen.
  // With reduced motion they're all shown at once, and switching it on
  // mid-reveal completes the reveal for good.
  const [revealed, setRevealed] = useState(() =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ? OUTPUT.length : 0,
  );
  const reduced = usePrefersReducedMotion(() => setRevealed(OUTPUT.length));
  const lines = reduced ? OUTPUT.length : revealed;

  useEffect(() => {
    // Once started it finishes, even if scrolled away.
    if (reduced || (!inView && lines === 0) || lines >= OUTPUT.length) return;
    const id = window.setTimeout(() => setRevealed((l) => l + 1), lines === 0 ? 900 : 420);
    return () => window.clearTimeout(id);
  }, [reduced, inView, lines]);

  return (
    <div ref={ref} className="card-surface flex h-full flex-col overflow-hidden rounded-2xl">
      <div className="flex h-10 items-center gap-2 border-b border-border px-4">
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-2.5 rounded-full bg-foreground/15" />
        ))}
        <span className="ml-3 font-mono text-xs text-muted-foreground">~/lumen</span>
      </div>
      <div className="flex flex-1 flex-col gap-1 p-4 font-mono text-[13px] leading-6">
        {INSTALL_STEPS.map(({ cmd, note }) => (
          <div key={cmd} className="group flex items-start gap-3 rounded-md px-2 py-1 hover:bg-accent/50">
            <span className="select-none text-brand">$</span>
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              {cmd}
              {note && <span className="block text-muted-foreground"># {note}</span>}
            </span>
            <button
              type="button"
              onClick={() => copy(cmd)}
              className="press grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
              aria-label={`Copy: ${cmd}`}
            >
              <IconSwap
                show={copied === cmd ? "b" : "a"}
                a={<Copy className="size-3.5" />}
                b={<Check className="size-3.5 text-success" />}
                className="size-3.5"
              />
            </button>
          </div>
        ))}
        <div className="mt-2 flex flex-col px-2">
          {OUTPUT.map((o, i) => (
            <div
              key={o.name}
              className={clsx(
                "flex gap-3 transition-[opacity,translate] duration-300 ease-[var(--ease-out)] motion-reduce:transition-none",
                i < lines ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
              )}
            >
              <span className="text-success">✔</span>
              <span className="w-20">{o.name}</span>
              <span className="text-muted-foreground">{o.detail}</span>
            </div>
          ))}
          <div
            className={clsx(
              "mt-1 transition-opacity duration-300",
              lines >= OUTPUT.length ? "opacity-100" : "opacity-0",
            )}
          >
            <span className="text-muted-foreground">Open </span>
            <span className="text-foreground underline decoration-foreground/40 underline-offset-4">
              http://localhost:8081
            </span>
            <span className="text-muted-foreground"> and sign in as admin.</span>
            <span className="ml-1 inline-block h-4 w-2 translate-y-0.5 animate-blink bg-foreground/70" />
          </div>
        </div>
      </div>
    </div>
  );
}

// Diagram geometry, in viewBox units (520 × 300).
const CLIENTS = [
  { icon: Globe, label: "Web", sub: "any browser", cy: 60 },
  { icon: Laptop, label: "Desktop", sub: "Electron", cy: 150 },
  { icon: Smartphone, label: "Mobile", sub: "iOS · Android", cy: 240 },
];
const STORES = [
  { icon: Database, label: "Postgres", sub: "metadata", cy: 95 },
  { icon: FolderOpen, label: "/mnt/music", sub: "your files", cy: 205 },
];
const SERVER = { x: 196, y: 92, w: 148, h: 116 };
const clientPath = (cy: number) => `M150 ${cy} C 176 ${cy}, 170 150, ${SERVER.x} 150`;
const storePath = (cy: number) => `M${SERVER.x + SERVER.w} 150 C 370 150, 364 ${cy}, 386 ${cy}`;

function Node({
  x,
  cy,
  w,
  icon: I,
  label,
  sub,
}: {
  x: number;
  cy: number;
  w: number;
  icon: typeof Globe;
  label: string;
  sub: string;
}) {
  return (
    <g>
      <rect x={x} y={cy - 22} width={w} height={44} rx="10" className="fill-background stroke-border" />
      <rect x={x + 8} y={cy - 14} width="28" height="28" rx="7" className="fill-muted" />
      <I x={x + 14} y={cy - 8} width="16" height="16" strokeWidth={1.75} className="text-foreground/80" />
      <text x={x + 44} y={cy - 2} fontSize="12" fontWeight="500" className="fill-foreground">
        {label}
      </text>
      <text x={x + 44} y={cy + 12} fontSize="9.5" className="fill-muted-foreground font-mono">
        {sub}
      </text>
    </g>
  );
}

/** Clients → server → storage. Requests travel in; audio comes back out. */
function Architecture() {
  return (
    <div className="card-surface relative flex items-center overflow-hidden rounded-2xl p-5">
      <div className="bg-grid absolute inset-0 opacity-70 [mask-image:none]" />
      <svg
        viewBox="0 0 520 300"
        className="relative h-auto w-full"
        fill="none"
        role="img"
        aria-label="Web, desktop and mobile apps talk to the Lumen server, which reads Postgres and your music folder"
      >
        {/* Links */}
        {CLIENTS.map((c, i) => (
          <path
            key={c.label}
            id={`arch-c${i}`}
            d={clientPath(c.cy)}
            className="stroke-foreground/25"
            strokeWidth="1.5"
            strokeDasharray="3 5"
          />
        ))}
        {STORES.map((s, i) => (
          <path
            key={s.label}
            id={`arch-s${i}`}
            d={storePath(s.cy)}
            className="stroke-foreground/25"
            strokeWidth="1.5"
            strokeDasharray="3 5"
          />
        ))}
        <text x="173" y="24" fontSize="9" textAnchor="middle" className="fill-muted-foreground font-mono">
          HTTPS · WS
        </text>
        <text x="365" y="64" fontSize="9" textAnchor="middle" className="fill-muted-foreground font-mono">
          SQL
        </text>
        <text x="365" y="250" fontSize="9" textAnchor="middle" className="fill-muted-foreground font-mono">
          range reads
        </text>

        {/* Packets: a request out to the server, audio back to the client. */}
        <g className="motion-reduce:hidden">
          {CLIENTS.map((c, i) => (
            <g key={c.label}>
              <circle r="2.5" className="fill-foreground/40">
                <animateMotion dur="2.6s" begin={`${i * 0.7}s`} repeatCount="indefinite">
                  <mpath href={`#arch-c${i}`} />
                </animateMotion>
              </circle>
              <circle r="3" className="fill-foreground">
                <animateMotion
                  dur="2.6s"
                  begin={`${i * 0.7 + 1.3}s`}
                  repeatCount="indefinite"
                  keyPoints="1;0"
                  keyTimes="0;1"
                  calcMode="linear"
                >
                  <mpath href={`#arch-c${i}`} />
                </animateMotion>
              </circle>
            </g>
          ))}
          {STORES.map((s, i) => (
            <circle key={s.label} r="2.5" className="fill-foreground/70">
              <animateMotion
                dur="1.8s"
                begin={`${i * 0.9}s`}
                repeatCount="indefinite"
                keyPoints="1;0"
                keyTimes="0;1"
                calcMode="linear"
              >
                <mpath href={`#arch-s${i}`} />
              </animateMotion>
            </circle>
          ))}
        </g>

        {CLIENTS.map((c) => (
          <Node key={c.label} x={16} w={134} {...c} />
        ))}
        {STORES.map((s) => (
          <Node key={s.label} x={386} w={122} {...s} />
        ))}

        {/* Server */}
        <g>
          <rect
            x={SERVER.x - 6}
            y={SERVER.y - 6}
            width={SERVER.w + 12}
            height={SERVER.h + 12}
            rx="18"
            className="fill-foreground/[0.03] stroke-foreground/10"
          />
          <rect
            x={SERVER.x}
            y={SERVER.y}
            width={SERVER.w}
            height={SERVER.h}
            rx="13"
            className="fill-card stroke-foreground/25"
          />
          <rect
            x={SERVER.x + SERVER.w / 2 - 17}
            y={SERVER.y + 14}
            width="34"
            height="34"
            rx="9"
            className="fill-foreground"
          />
          <Server
            x={SERVER.x + SERVER.w / 2 - 9}
            y={SERVER.y + 22}
            width="18"
            height="18"
            strokeWidth={1.75}
            className="text-background"
          />
          <text
            x={SERVER.x + SERVER.w / 2}
            y={SERVER.y + 66}
            fontSize="13"
            fontWeight="600"
            textAnchor="middle"
            className="fill-foreground"
          >
            Lumen server
          </text>
          <text
            x={SERVER.x + SERVER.w / 2}
            y={SERVER.y + 81}
            fontSize="9.5"
            textAnchor="middle"
            className="fill-muted-foreground font-mono"
          >
            Go · :8080
          </text>
          <circle cx={SERVER.x + SERVER.w / 2 - 22} cy={SERVER.y + 97} r="3" className="fill-success" />
          <circle
            cx={SERVER.x + SERVER.w / 2 - 22}
            cy={SERVER.y + 97}
            r="3"
            className="fill-success motion-safe:animate-ping"
            style={{ transformBox: "fill-box", transformOrigin: "center" }}
          />
          <text
            x={SERVER.x + SERVER.w / 2 - 14}
            y={SERVER.y + 100.5}
            fontSize="9.5"
            className="fill-muted-foreground font-mono"
          >
            healthy
          </text>
        </g>
      </svg>
    </div>
  );
}

const SECURITY = [
  { icon: KeyRound, text: "Argon2id password hashing" },
  { icon: Lock, text: "HTTP-only cookie sessions" },
  { icon: Link2, text: "HMAC-signed public links" },
  { icon: Server, text: "Binds to 127.0.0.1 by default" },
];

export default function SelfHost() {
  return (
    <section id="self-host" className="relative border-t border-border bg-sidebar/40 py-28">
      <div className="mx-auto max-w-6xl px-5">
        <SectionHeading eyebrow="Self-host">Up and running in three commands.</SectionHeading>

        <div className="mt-16 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="reveal min-w-0">
            <Terminal />
          </div>
          <div className="reveal grid min-w-0" style={delay(100)}>
            <Architecture />
          </div>
          <ul className="reveal grid gap-4 sm:grid-cols-2 lg:col-span-2 lg:grid-cols-4" style={delay(160)}>
            {SECURITY.map(({ icon: I, text }) => (
              <li key={text} className="card-surface flex items-center gap-3 rounded-xl px-4 py-3.5 text-[13px]">
                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted">
                  <I className="size-3.5" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>

        <div className="reveal mt-10 flex justify-center">
          <ButtonLink href={README_URL} variant="outline">
            Read the setup guide
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
