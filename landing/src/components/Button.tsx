import { Show, splitProps, type JSX } from "solid-js";

type Variant = "primary" | "secondary" | "ghost";
type Size = "md" | "lg";

interface ButtonProps {
  variant?: Variant;
  size?: Size;
  /** Renders an anchor when set, a button otherwise. */
  href?: string;
  /** Opens in a new tab with the matching rel. */
  external?: boolean;
  iconOnly?: boolean;
  leading?: JSX.Element;
  trailing?: JSX.Element;
  type?: "button" | "submit";
  class?: string;
  title?: string;
  "aria-label"?: string;
  onClick?: JSX.EventHandlerUnion<
    HTMLButtonElement | HTMLAnchorElement,
    MouseEvent
  >;
  children?: JSX.Element;
}

const VARIANT_CLASS: Record<Variant, string> = {
  primary: "btn btn-primary",
  secondary: "btn",
  ghost: "btn btn-ghost",
};

export function Button(props: ButtonProps): JSX.Element {
  const [local, shared] = splitProps(props, [
    "variant",
    "size",
    "href",
    "external",
    "iconOnly",
    "leading",
    "trailing",
    "type",
    "class",
    "children",
  ]);
  const classes = () =>
    [
      VARIANT_CLASS[local.variant ?? "secondary"],
      local.size === "lg" ? "btn-lg" : "",
      local.iconOnly ? "btn-icon" : "",
      local.class ?? "",
    ]
      .filter(Boolean)
      .join(" ");
  const content = () => (
    <>
      {local.leading}
      {local.children}
      {local.trailing}
    </>
  );

  return (
    <Show
      when={local.href}
      fallback={
        <button class={classes()} type={local.type ?? "button"} {...shared}>
          {content()}
        </button>
      }
    >
      {(href) => (
        <a
          class={classes()}
          href={href()}
          target={local.external ? "_blank" : undefined}
          rel={local.external ? "noreferrer" : undefined}
          {...shared}
        >
          {content()}
        </a>
      )}
    </Show>
  );
}
