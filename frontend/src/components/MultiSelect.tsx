import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Check as CheckIcon, ChevronsUpDown as ChevronUpDownIcon } from "lucide-react";
import { useDismiss } from "../lib/useDismiss";
import { useTransitionMount } from "../lib/useTransitionMount";

export interface MultiSelectOption<V extends string = string> {
  value: V;
  label: string;
  /** A muted second line under the label. */
  detail?: string;
  /** A short tag after the label, e.g. "Shown". */
  tag?: string;
  /** Shown before the label, e.g. a marker the selection is drawn with. */
  icon?: ReactNode;
}

interface MultiSelectProps<V extends string = string> {
  values: V[];
  onChange: (values: V[]) => void;
  options: MultiSelectOption<V>[];
  /** The trigger's text, describing the current selection. */
  summary: string;
  /** The fewest options that may stay selected. */
  min?: number;
  className?: string;
  /** Names the list, and the trigger ahead of its summary. */
  "aria-label"?: string;
}

/**
 * A dropdown of checkable options, the many-valued sibling of `Select`: same
 * trigger, listbox, keys and dismissal, but picking an option toggles it and
 * leaves the list open. Selected values come back in option order.
 */
export function MultiSelect<V extends string = string>({
  values,
  onChange,
  options,
  summary,
  min = 1,
  className,
  "aria-label": ariaLabel,
}: MultiSelectProps<V>) {
  const buttonId = useId();
  const listId = `${buttonId}-listbox`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const { mounted, visible } = useTransitionMount(open, 150);

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);
  const ignoreTrigger = useCallback(
    (t: Node) => buttonRef.current?.contains(t) ?? false,
    [],
  );
  // Capture phase: a dialog layer stops mousedown from bubbling to window, so
  // clicks elsewhere in the dialog would otherwise leave the list open.
  // Focus goes back to the trigger rather than leaving with the list; a
  // focusable click target still takes it from there.
  useDismiss(listRef, {
    onDismiss: close,
    enabled: open,
    capture: true,
    ignore: ignoreTrigger,
  });

  // Keyed to `open` as well as `mounted`: reopening during the exit fade
  // keeps the list mounted, and it must still take focus again.
  const shown = open && mounted;
  useEffect(() => {
    if (!shown) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActive(0);
    listRef.current?.focus();
  }, [shown]);

  // Open upward when the list would run past the bottom of whatever clips it
  // (a dialog's scrolling pane, or the window) and there's more room above.
  // Set directly on the element, and afresh on every open.
  useLayoutEffect(() => {
    const list = listRef.current;
    const button = buttonRef.current;
    if (!shown || !list || !button) return;
    delete list.dataset.side;
    const clip = clipRect(button);
    const below = clip.bottom - button.getBoundingClientRect().bottom;
    const above = button.getBoundingClientRect().top - clip.top;
    if (list.offsetHeight + 8 > below && above > below) {
      list.dataset.side = "top";
    }
  }, [shown]);

  useEffect(() => {
    if (!mounted) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, mounted]);

  // The last `min` selected options can't be unticked.
  const locked = (value: V) => values.includes(value) && values.length <= min;

  const toggle = (index: number) => {
    const option = options[index];
    if (!option || locked(option.value)) return;
    const on = values.includes(option.value);
    const next = new Set(values);
    if (on) next.delete(option.value);
    else next.add(option.value);
    onChange(options.filter((o) => next.has(o.value)).map((o) => o.value));
  };

  const onButtonKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onListKey = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    if (!open) return;
    const last = options.length - 1;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        close();
        return;
      case "Tab":
        buttonRef.current?.focus();
        setOpen(false);
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        toggle(active);
        return;
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => (i >= last ? 0 : i + 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => (i <= 0 ? last : i - 1));
        return;
      case "Home":
        e.preventDefault();
        setActive(0);
        return;
      case "End":
        e.preventDefault();
        setActive(last);
        return;
    }
  };

  return (
    <div className={`relative ${className ?? ""}`}>
      <button
        ref={buttonRef}
        type="button"
        id={buttonId}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        // Keep the visible summary in the name, after what it picks.
        aria-label={ariaLabel ? `${ariaLabel}: ${summary}` : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onButtonKey}
        className="multi-select-trigger"
      >
        <span className="truncate">{summary}</span>
        <ChevronUpDownIcon className="size-3.5 shrink-0" aria-hidden="true" />
      </button>
      {mounted && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-multiselectable="true"
          aria-label={ariaLabel}
          tabIndex={-1}
          aria-activedescendant={`${buttonId}-opt-${active}`}
          data-closed={!visible || undefined}
          // Inert while it fades out.
          style={open ? undefined : { pointerEvents: "none" }}
          onKeyDown={onListKey}
          className="multi-select-list menu transition-[opacity,transform] duration-150 ease-out data-closed:scale-95 data-closed:opacity-0 motion-reduce:transition-none"
        >
          {options.map((o, i) => {
            const selected = values.includes(o.value);
            return (
              <li
                key={o.value}
                id={`${buttonId}-opt-${i}`}
                role="option"
                aria-selected={selected}
                aria-disabled={locked(o.value) || undefined}
                data-index={i}
                data-active={i === active || undefined}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggle(i)}
                className="menu-item multi-select-option"
              >
                <span className="multi-select-box" data-checked={selected || undefined}>
                  {selected && <CheckIcon className="size-3" aria-hidden="true" />}
                </span>
                <span className="multi-select-text">
                  <span className="multi-select-label">
                    {o.icon}
                    <span className="truncate">{o.label}</span>
                    {o.tag && <span className="badge">{o.tag}</span>}
                  </span>
                  {o.detail && <span className="multi-select-detail">{o.detail}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The box of the nearest ancestor that clips `el`, else the window's. */
function clipRect(el: HTMLElement): { top: number; bottom: number } {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY !== "visible" && overflowY !== "clip") {
      const r = node.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    }
  }
  return { top: 0, bottom: window.innerHeight };
}
