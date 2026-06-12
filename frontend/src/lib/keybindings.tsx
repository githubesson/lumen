import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/**
 * Central keyboard-binding framework.
 *
 * Key strings use "+" as separator. Tokens (case-insensitive):
 *   - "mod"   → Cmd on macOS, Ctrl elsewhere (the "command" key of the platform)
 *   - "ctrl"  → Ctrl, literally (cross-platform)
 *   - "meta"  → Cmd / Windows key, literally
 *   - "alt"   → Alt / Option
 *   - "shift" → Shift
 *   - "space", "esc", "enter", "tab", "up", "down", "left", "right", "plus", "/", "?"
 *   - any single character: "a", "k", "1"
 *
 * Examples:
 *   - "mod+k"       → ⌘K on Mac, Ctrl+K elsewhere
 *   - "ctrl+b"      → Ctrl+B on every platform
 *   - "space"       → Space with no modifiers
 *   - "shift+/"     → ? (common "show help" binding)
 */

export interface KeyBinding {
  id: string;
  keys: string;
  label?: string;
  group?: string;
  allowInInput?: boolean;
  priority?: number;
  handler: (e: KeyboardEvent) => void;
}

interface Registry {
  register: (b: KeyBinding) => () => void;
  subscribe: (listener: () => void) => () => void;
  snapshot: () => KeyBinding[];
}

const Ctx = createContext<Registry | null>(null);

const IS_MAC =
  typeof navigator !== "undefined" &&
  (/(Mac|iPhone|iPod|iPad)/i.test(navigator.platform) ||
    /Mac/i.test(navigator.userAgent));

interface Parsed {
  key: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

const KEY_ALIASES: Record<string, string> = {
  space: " ",
  esc: "escape",
  enter: "enter",
  return: "enter",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  plus: "+",
};

function parse(binding: string): Parsed {
  // Split on "+" but treat a literal trailing "+" (e.g. "ctrl++") as the key.
  const raw = binding.trim().toLowerCase();
  const tokens = raw.split("+").filter((t, i, arr) => {
    // Support trailing "+": "ctrl++" → tokens ["ctrl", "", ""] → keep the "+"
    return t.length > 0 || i === arr.length - 1;
  });

  let key: string = tokens.pop() ?? "";
  if (key === "") key = "+";
  key = KEY_ALIASES[key] ?? key;

  return {
    key,
    mod: tokens.includes("mod"),
    ctrl: tokens.includes("ctrl"),
    meta: tokens.includes("meta") || tokens.includes("cmd"),
    alt: tokens.includes("alt") || tokens.includes("option"),
    shift: tokens.includes("shift"),
  };
}

function eventKey(e: KeyboardEvent): string {
  const k = e.key.toLowerCase();
  // Normalize: some browsers emit "Spacebar" instead of " ".
  if (k === "spacebar") return " ";
  return k;
}

function matches(p: Parsed, e: KeyboardEvent): boolean {
  if (eventKey(e) !== p.key) return false;

  // Modifier matching.
  const wantCtrl = p.ctrl || (p.mod && !IS_MAC);
  const wantMeta = p.meta || (p.mod && IS_MAC);
  const wantAlt = p.alt;
  const wantShift = p.shift;

  if (Boolean(e.ctrlKey) !== wantCtrl) return false;
  if (Boolean(e.metaKey) !== wantMeta) return false;
  if (Boolean(e.altKey) !== wantAlt) return false;
  if (Boolean(e.shiftKey) !== wantShift) return false;
  return true;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

export function KeyBindingsProvider({ children }: { children: ReactNode }) {
  const bindings = useRef<Map<string, KeyBinding>>(new Map());
  const listeners = useRef<Set<() => void>>(new Set());

  const registry = useMemo<Registry>(() => {
    // Cache the snapshot array and only rebuild it on a real change, so
    // useSyncExternalStore's stable-snapshot contract holds (returning a fresh
    // Array.from() every call causes an infinite re-render loop).
    let snapshotCache: KeyBinding[] = [];
    const notify = () => {
      snapshotCache = Array.from(bindings.current.values());
      for (const l of listeners.current) l();
    };
    return {
      register(b) {
        bindings.current.set(b.id, b);
        notify();
        return () => {
          if (bindings.current.get(b.id) === b) {
            bindings.current.delete(b.id);
            notify();
          }
        };
      },
      subscribe(l) {
        listeners.current.add(l);
        return () => listeners.current.delete(l);
      },
      snapshot() {
        return snapshotCache;
      },
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inEditable = isEditableTarget(e.target);

      let best: KeyBinding | null = null;
      let bestPriority = -Infinity;
      for (const b of bindings.current.values()) {
        if (inEditable && !b.allowInInput) continue;
        const parsed = parse(b.keys);
        if (!matches(parsed, e)) continue;
        const p = b.priority ?? 0;
        if (p > bestPriority) {
          best = b;
          bestPriority = p;
        }
      }
      if (best) best.handler(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return <Ctx.Provider value={registry}>{children}</Ctx.Provider>;
}

interface UseKeyOptions {
  id?: string;
  label?: string;
  group?: string;
  allowInInput?: boolean;
  priority?: number;
  enabled?: boolean;
}

/**
 * Register a keybinding for the lifetime of the calling component.
 * The handler is always up-to-date (no stale closures).
 */
export function useKey(
  keys: string,
  handler: (e: KeyboardEvent) => void,
  opts: UseKeyOptions = {},
) {
  const reg = useContext(Ctx);
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  const enabled = opts.enabled ?? true;
  const idPrefix = opts.id ?? `key:${keys}`;
  // Stable per-hook-instance suffix so the binding id doesn't change on every
  // effect re-run (which would churn register/unregister and break opts.id).
  const uid = useId();

  useEffect(() => {
    if (!reg || !enabled) return;
    // Ensure unique ids even if the same hook is used in multiple components.
    const id = `${idPrefix}@${uid}`;
    return reg.register({
      id,
      keys,
      label: opts.label,
      group: opts.group,
      allowInInput: opts.allowInInput,
      priority: opts.priority,
      handler: (e) => handlerRef.current(e),
    });
  }, [
    reg,
    enabled,
    keys,
    idPrefix,
    uid,
    opts.label,
    opts.group,
    opts.allowInInput,
    opts.priority,
  ]);
}

/** Observe the full list of currently registered bindings (for a help panel). */
export function useKeyBindings(): KeyBinding[] {
  const reg = useContext(Ctx);
  return useSyncExternalStore(
    useCallback(
      (l) => (reg ? reg.subscribe(l) : () => {}),
      [reg],
    ),
    useCallback(() => (reg ? reg.snapshot() : []), [reg]),
    () => [],
  );
}

/** Pretty-print a binding string for display. */
export function formatKeys(keys: string): string {
  return keys
    .split("+")
    .map((t) => {
      const k = t.toLowerCase();
      if (k === "mod") return IS_MAC ? "⌘" : "Ctrl";
      if (k === "meta" || k === "cmd") return IS_MAC ? "⌘" : "Win";
      if (k === "ctrl") return "Ctrl";
      if (k === "alt" || k === "option") return IS_MAC ? "⌥" : "Alt";
      if (k === "shift") return IS_MAC ? "⇧" : "Shift";
      if (k === "space") return "Space";
      if (k === "esc") return "Esc";
      if (k === "enter" || k === "return") return "↵";
      if (k === "up") return "↑";
      if (k === "down") return "↓";
      if (k === "left") return "←";
      if (k === "right") return "→";
      return t.length === 1 ? t.toUpperCase() : t[0].toUpperCase() + t.slice(1);
    })
    .join(IS_MAC ? "" : "+");
}
