import clsx from "clsx";
import { Check, Copy, RefreshCw, Ticket } from "lucide-react";
import { useEffect, useState } from "react";
import { useCopy, usePrefersReducedMotion } from "../../lib/hooks";
import IconSwap from "../IconSwap";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const randomToken = () => Array.from({ length: 10 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");

/** An admin-minted invite; "New" rolls a fresh token with a quick scramble. */
export default function InviteDemo() {
  const [token, setToken] = useState("q7mx2kfw9p");
  const [scrambling, setScrambling] = useState(false);
  // Switching reduced motion on mid-scramble stops it on the current token.
  const reduced = usePrefersReducedMotion(() => setScrambling(false));
  const { copied, copy } = useCopy();
  const link = `https://music.example.com/invite/${token}`;

  useEffect(() => {
    if (!scrambling) return;
    let n = 0;
    const id = window.setInterval(() => {
      setToken(randomToken());
      if (++n >= 8) {
        window.clearInterval(id);
        setScrambling(false);
      }
    }, 45);
    return () => window.clearInterval(id);
  }, [scrambling]);

  return (
    <div className="w-full max-w-xs rounded-xl border border-border bg-background/70 p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="grid size-8 place-items-center rounded-lg bg-brand-soft text-brand">
          <Ticket className="size-4" />
        </span>
        <div className="flex-1">
          <div className="text-sm font-medium">Invite</div>
          <div className="text-xs text-muted-foreground">Role: member</div>
        </div>
        <button
          type="button"
          // With reduced motion the new token just appears, no scramble.
          onClick={() => (reduced ? setToken(randomToken()) : setScrambling(true))}
          className="press flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs hover:bg-accent"
        >
          <RefreshCw className={clsx("size-3", scrambling && "animate-spin")} /> New
        </button>
      </div>

      <button
        type="button"
        onClick={() => copy(link)}
        className="mt-3 flex w-full items-center gap-2 rounded-md border border-dashed border-border bg-muted/50 px-2.5 py-2 text-left font-mono text-[12px] press hover:border-ring/60"
        aria-label="Copy example invite link"
      >
        <span className="truncate text-muted-foreground">
          /invite/<span className="text-foreground">{token}</span>
        </span>
        <IconSwap
          show={copied === link ? "b" : "a"}
          a={<Copy className="size-3.5 text-muted-foreground" />}
          b={<Check className="size-3.5 text-success" />}
          className="ml-auto size-3.5 shrink-0"
        />
      </button>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-md bg-muted/50 px-2.5 py-2">
          <div className="text-muted-foreground">Uses</div>
          <div className="mt-0.5 font-medium tabular-nums">2 / 5</div>
          <div className="mt-1.5 h-1 rounded-full bg-muted">
            <div className="h-full w-2/5 rounded-full bg-brand" />
          </div>
        </div>
        <div className="rounded-md bg-muted/50 px-2.5 py-2">
          <div className="text-muted-foreground">Expires</div>
          <div className="mt-0.5 font-medium">in 6 days</div>
        </div>
      </div>
    </div>
  );
}
