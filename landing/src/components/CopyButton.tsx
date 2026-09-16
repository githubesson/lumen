import { createSignal, onCleanup, type JSX } from "solid-js";
import { Button } from "./Button";
import { Icon } from "./Icons";

export function CopyButton(props: {
  text: string;
  label?: string;
}): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  async function copy() {
    try {
      await navigator.clipboard.writeText(props.text);
      setCopied(true);
      clearTimeout(timer);
      timer = setTimeout(() => setCopied(false), 1600);
    } catch {
      /* Clipboard blocked; the text is still selectable by hand. */
    }
  }

  return (
    <Button
      variant="ghost"
      iconOnly
      aria-label={props.label ?? "Copy to clipboard"}
      title={props.label ?? "Copy to clipboard"}
      onClick={copy}
    >
      <span class="relative grid size-[18px] place-items-center">
        <Icon
          name="copy"
          class={`icon-swap ${!copied() ? "icon-swap-on" : ""}`}
        />
        <Icon
          name="check"
          class={`icon-swap ${copied() ? "icon-swap-on" : ""}`}
        />
      </span>
      <span class="sr-only" role="status" aria-live="polite">
        {copied() ? "Copied" : ""}
      </span>
    </Button>
  );
}
