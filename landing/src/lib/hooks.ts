import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export type Theme = "light" | "dark";
const THEME_KEY = "lumen-landing-theme";

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // Browser chrome (mobile address bar) follows the site theme, not the OS.
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0a0a0a" : "#ffffff");
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* private mode */
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}

/** Live prefers-reduced-motion. `onReduce` runs when the preference is
 *  switched on after mount, so a demo can jump to its finished state (and
 *  stay there if the preference is later switched off again). */
export function usePrefersReducedMotion(onReduce?: () => void) {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const onReduceRef = useRef(onReduce);
  useEffect(() => {
    onReduceRef.current = onReduce;
  });
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => {
      setReduced(mq.matches);
      if (mq.matches) onReduceRef.current?.();
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** Marks every `.reveal` element with data-shown once it scrolls into view. */
export function useRevealOnScroll() {
  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>(".reveal:not([data-shown])");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.setAttribute("data-shown", "");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

/** True while the element is on screen, so off-screen demos stop ticking. */
export function useInView<T extends Element>() {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, inView] as const;
}

/** Calls `tick` on an interval while `active`. */
export function useInterval(tick: () => void, ms: number, active = true) {
  const saved = useRef(tick);
  useEffect(() => {
    saved.current = tick;
  });
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => saved.current(), ms);
    return () => window.clearInterval(id);
  }, [ms, active]);
}

/** Feeds pointer position to the `.spotlight` gradient. */
export function spotlight(e: PointerEvent<HTMLElement>) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--mx", `${e.clientX - r.left}px`);
  el.style.setProperty("--my", `${e.clientY - r.top}px`);
}

/** Clipboard API where available; otherwise the legacy execCommand path.
 *  navigator.clipboard only exists in secure contexts (HTTPS, localhost), so
 *  plain-HTTP self-hosted or LAN setups need the fallback. */
async function writeClipboard(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or document not focused: try the fallback.
    }
  }
  // Selecting the textarea moves focus to it; put focus back afterwards so
  // keyboard users stay on the button they pressed.
  const previous = document.activeElement as HTMLElement | null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus({ preventScroll: true });
  }
}

/** Speaks a short status message through the page's polite live region
 *  (rendered once in App), for state that is otherwise only shown visually. */
export function announce(message: string) {
  const region = document.getElementById("live-region");
  if (!region) return;
  // Clear first so repeating the same message is announced again.
  region.textContent = "";
  window.setTimeout(() => (region.textContent = message), 50);
}

export function useCopy(timeout = 1600) {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(null), timeout);
    return () => window.clearTimeout(id);
  }, [copied, timeout]);
  const copy = useCallback((text: string) => {
    void writeClipboard(text).then((ok) => {
      announce(ok ? "Copied to clipboard" : "Couldn't copy to the clipboard");
      if (ok) setCopied(text);
    });
  }, []);
  return { copied, copy };
}

export function formatTime(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Whether a demo may animate on its own: on screen and the visitor hasn't
 *  asked for reduced motion. Anything the visitor triggers still works. */
export function useAutoplay(inView: boolean) {
  const reduced = usePrefersReducedMotion();
  return inView && !reduced;
}

/** Standard slider keys (ARIA APG): arrows step, Page keys jump, Home/End go
 *  to the ends. `value` and the result are fractions from 0 to 1. */
export function sliderKey(e: KeyboardEvent, value: number, step: number, onChange: (next: number) => void) {
  const next = {
    ArrowRight: value + step,
    ArrowUp: value + step,
    ArrowLeft: value - step,
    ArrowDown: value - step,
    PageUp: value + step * 5,
    PageDown: value - step * 5,
    Home: 0,
    End: 1,
  }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  onChange(Math.min(1, Math.max(0, next)));
}
