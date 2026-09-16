import { createSignal } from "solid-js";

export type Theme = "dark" | "light";

const STORAGE_KEY = "lumen-landing.theme";

function current(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light"
    ? "light"
    : "dark";
}

const [theme, setThemeSignal] = createSignal<Theme>(current());

export { theme };

export function toggleTheme(): void {
  const next: Theme = theme() === "dark" ? "light" : "dark";
  // Every surface changes colour at once on a theme flip. Suppress transitions
  // for one frame so the switch snaps instead of smearing.
  const style = document.createElement("style");
  style.textContent = "*,*::before,*::after{transition:none!important}";
  document.head.appendChild(style);
  document.documentElement.setAttribute("data-theme", next);
  void document.documentElement.offsetHeight;
  requestAnimationFrame(() => style.remove());
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* storage unavailable; the choice lasts for this page view */
  }
  setThemeSignal(next);
}
