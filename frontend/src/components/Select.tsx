import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { CheckIcon, ChevronUpDownIcon } from "@heroicons/react/16/solid";
import { useDismiss } from "../lib/useDismiss";
import { useTransitionMount } from "../lib/useTransitionMount";

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

type Variant = "outlined" | "minimal";

interface SelectProps<V extends string = string> {
  value: V;
  onChange: (value: V) => void;
  options: SelectOption<V>[];
  placeholder?: string;
  name?: string;
  id?: string;
  disabled?: boolean;
  variant?: Variant;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

const TRIGGER: Record<Variant, string> = {
  outlined:
    "flex w-full items-center justify-between gap-x-2 input text-left",
  minimal:
    "inline-flex items-center gap-x-1 text-[12.5px] mono text-muted hover:text-fg focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
};

const POPUP_BASE =
  "origin-top transition-[opacity,transform] duration-150 ease-out data-closed:scale-95 data-closed:opacity-0 motion-reduce:transition-none menu";

const POPUP: Record<Variant, string> = {
  outlined: `absolute z-30 mt-1 max-h-60 w-full overflow-y-auto focus:outline-none ${POPUP_BASE}`,
  minimal: `absolute right-0 z-30 mt-1 max-h-60 w-max min-w-40 overflow-y-auto focus:outline-none ${POPUP_BASE}`,
};

export function Select<V extends string = string>({
  value,
  onChange,
  options,
  placeholder = "Select…",
  name,
  id,
  disabled,
  variant = "outlined",
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: SelectProps<V>) {
  const autoId = useId();
  const buttonId = id ?? autoId;
  const listId = `${buttonId}-listbox`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typeahead = useRef({ buffer: "", timer: 0 });
  const { mounted, visible } = useTransitionMount(open, 150);

  const selectedIndex = useMemo(
    () => options.findIndex((o) => o.value === value),
    [options, value],
  );
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  const ignoreTrigger = useCallback(
    (t: Node) => buttonRef.current?.contains(t) ?? false,
    [],
  );
  const dismiss = useCallback(() => setOpen(false), []);
  useDismiss(listRef, { onDismiss: dismiss, enabled: open, ignore: ignoreTrigger });

  useEffect(() => {
    if (!mounted) return;
    setActive(selectedIndex >= 0 ? selectedIndex : firstEnabled(options));
    listRef.current?.focus();
  }, [mounted, selectedIndex, options]);

  useEffect(() => {
    if (!mounted || active < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, mounted]);

  const commit = (index: number) => {
    const o = options[index];
    if (!o || o.disabled) return;
    onChange(o.value);
    close();
  };

  const move = (delta: number) => {
    if (options.length === 0) return;
    let i = active < 0 ? (delta > 0 ? -1 : options.length) : active;
    for (let n = 0; n < options.length; n++) {
      i = (i + delta + options.length) % options.length;
      if (!options[i].disabled) break;
    }
    setActive(i);
  };

  const onButtonKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (
      e.key === "ArrowDown" ||
      e.key === "ArrowUp" ||
      e.key === "Enter" ||
      e.key === " "
    ) {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onListKey = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    switch (e.key) {
      case "Escape":
      case "Tab":
        e.preventDefault();
        close();
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(active);
        return;
      case "ArrowDown":
        e.preventDefault();
        move(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        return;
      case "Home":
        e.preventDefault();
        setActive(firstEnabled(options));
        return;
      case "End":
        e.preventDefault();
        setActive(lastEnabled(options));
        return;
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      window.clearTimeout(typeahead.current.timer);
      typeahead.current.buffer += e.key.toLowerCase();
      const i = findMatch(options, typeahead.current.buffer, active);
      if (i >= 0) setActive(i);
      typeahead.current.timer = window.setTimeout(() => {
        typeahead.current.buffer = "";
      }, 500);
    }
  };

  return (
    <div className={`relative ${className ?? ""}`}>
      {name !== undefined && <input type="hidden" name={name} value={value} />}
      <button
        ref={buttonRef}
        type="button"
        id={buttonId}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onButtonKey}
        className={TRIGGER[variant]}
      >
        <span
          className="truncate"
          style={{
            color: selected ? "var(--fg)" : "var(--fg-subtle)",
            flex: 1,
            textAlign: "left",
          }}
        >
          {selected?.label ?? placeholder}
        </span>
        <ChevronUpDownIcon
          className="size-3.5 shrink-0"
          style={{ color: "var(--fg-subtle)" }}
          aria-hidden="true"
        />
      </button>
      {mounted && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={
            active >= 0 ? `${buttonId}-opt-${active}` : undefined
          }
          data-closed={!visible || undefined}
          onKeyDown={onListKey}
          className={POPUP[variant]}
        >
          {options.map((o, i) => {
            const isSelected = o.value === value;
            const isActive = i === active;
            return (
              <li
                key={o.value}
                id={`${buttonId}-opt-${i}`}
                role="option"
                aria-selected={isSelected}
                aria-disabled={o.disabled || undefined}
                data-index={i}
                onMouseEnter={() => !o.disabled && setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(i)}
                className="menu-item"
                style={{
                  cursor: o.disabled ? "not-allowed" : "pointer",
                  opacity: o.disabled ? 0.5 : 1,
                  background: isActive ? "var(--bg-elev-3)" : "transparent",
                  fontWeight: isSelected ? 500 : 400,
                }}
              >
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {o.label}
                </span>
                {isSelected && (
                  <CheckIcon
                    className="size-3.5 shrink-0"
                    style={{ color: "var(--accent)" }}
                    aria-hidden="true"
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function firstEnabled<V extends string>(options: SelectOption<V>[]): number {
  return options.findIndex((o) => !o.disabled);
}

function lastEnabled<V extends string>(options: SelectOption<V>[]): number {
  for (let i = options.length - 1; i >= 0; i--) {
    if (!options[i].disabled) return i;
  }
  return -1;
}

function findMatch<V extends string>(
  options: SelectOption<V>[],
  query: string,
  start: number,
): number {
  const len = options.length;
  if (len === 0) return -1;
  const s = start < 0 ? -1 : start;
  for (let n = 1; n <= len; n++) {
    const i = (s + n + len) % len;
    const o = options[i];
    if (!o.disabled && o.label.toLowerCase().startsWith(query)) return i;
  }
  return -1;
}
