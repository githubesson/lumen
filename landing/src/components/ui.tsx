import clsx from "clsx";
import { Check, Copy } from "lucide-react";
import type { AnchorHTMLAttributes, CSSProperties, ReactNode } from "react";
import IconSwap from "./IconSwap";
import { useCopy } from "../lib/hooks";

/** Stagger for `.reveal` elements. */
export const delay = (ms: number) => ({ "--delay": `${ms}ms` }) as CSSProperties;

type Variant = "primary" | "outline" | "ghost";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/85",
  outline: "border border-border bg-background/60 backdrop-blur hover:bg-accent dark:bg-input/20 dark:hover:bg-input/40",
  ghost: "hover:bg-accent dark:hover:bg-accent/60",
};
const sizes: Record<Size, string> = {
  sm: "h-8 gap-1.5 px-3 text-[13px]",
  md: "h-9 gap-2 px-4 text-sm",
  lg: "h-11 gap-2 px-5 text-[15px]",
};

export function ButtonLink({
  variant = "primary",
  size = "md",
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; size?: Size }) {
  const external = props.href?.startsWith("http");
  return (
    <a
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      {...props}
      className={clsx(
        "press inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-lg font-medium [&_svg]:size-4",
        variants[variant],
        sizes[size],
        className,
      )}
    />
  );
}

/** Small pill label above section headings. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground",
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-brand" />
      {children}
    </span>
  );
}

export function SectionHeading({
  eyebrow,
  children,
  align = "center",
}: {
  eyebrow: string;
  children: ReactNode;
  align?: "center" | "left";
}) {
  return (
    <div className={clsx("reveal flex flex-col gap-4", align === "center" ? "items-center text-center" : "items-start")}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="text-gradient max-w-3xl text-balance text-4xl font-semibold tracking-[-0.035em] sm:text-5xl">
        {children}
      </h2>
    </div>
  );
}

/** A shell command with a copy button. */
export function CommandPill({
  command,
  className,
  style,
}: {
  command: string;
  className?: string;
  style?: CSSProperties;
}) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(command)}
      style={style}
      className={clsx(
        "press group inline-flex h-11 items-center gap-3 rounded-lg border border-border bg-card/70 pl-4 pr-2 font-mono text-[13px] backdrop-blur hover:border-ring/60",
        className,
      )}
      aria-label={`Copy command: ${command}`}
    >
      <span className="text-brand select-none">$</span>
      <span className="truncate">{command}</span>
      <span className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors group-hover:bg-accent group-hover:text-foreground">
        <IconSwap
          show={copied === command ? "b" : "a"}
          a={<Copy className="size-3.5" />}
          b={<Check className="size-3.5 text-success" />}
          className="size-3.5"
        />
      </span>
    </button>
  );
}
