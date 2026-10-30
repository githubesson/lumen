import clsx from "clsx";
import { useId, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";

/** Stagger for the hero's `.enter` elements. */
export const delay = (ms: number) => ({ "--delay": `${ms}ms` }) as CSSProperties;

type Variant = "primary" | "outline" | "ghost";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/85",
  outline: "border border-border bg-background hover:bg-accent dark:bg-input/20 dark:hover:bg-input/40",
  ghost: "hover:bg-accent dark:hover:bg-accent/60",
};
const sizes: Record<Size, string> = {
  sm: "h-8 gap-1.5 px-3 text-[13px]",
  md: "h-9 gap-2 px-4 text-sm",
  lg: "h-11 gap-2 px-5 text-base",
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

/** Icon-only button. `label` names it and shows as a tooltip on hover and
 *  keyboard focus. `align="end"` keeps the tooltip inside the right edge;
 *  `wrapperClassName` places the button and its tooltip together. */
export function IconButton({
  label,
  align = "center",
  className,
  wrapperClassName,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; align?: "center" | "end"; wrapperClassName?: string }) {
  const id = useId();
  return (
    <span className={clsx("group/tip relative inline-flex", wrapperClassName)}>
      <button type="button" {...props} aria-labelledby={id} data-ui-tooltip={id} className={className} />
      <span
        id={id}
        role="tooltip"
        className={clsx(
          "pointer-events-none absolute top-full z-10 mt-2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background opacity-0 shadow transition-opacity duration-150 group-hover/tip:opacity-100 group-has-focus-visible/tip:opacity-100",
          align === "center" ? "left-1/2 -translate-x-1/2" : "right-0",
        )}
      >
        {label}
      </span>
    </span>
  );
}

/** A section's name in small muted text, then its heading. */
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
    <div className={clsx("flex flex-col gap-3", align === "center" ? "items-center text-center" : "items-start")}>
      <span className="text-sm text-muted-foreground">{eyebrow}</span>
      <h2 className="max-w-3xl text-balance text-4xl font-medium tracking-[-0.02em] sm:text-5xl">{children}</h2>
    </div>
  );
}
