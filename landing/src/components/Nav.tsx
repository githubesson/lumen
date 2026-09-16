import { createSignal, For, onCleanup, onMount, type JSX } from "solid-js";
import { Button } from "./Button";
import { BrandIcon } from "./Icons";
import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";
import { REPO_URL } from "../lib/site";

const LINKS = [
  { href: "#features", label: "Features" },
  { href: "#clients", label: "Clients" },
  { href: "#self-host", label: "Self-host" },
  { href: "#downloads", label: "Download" },
];

export function Nav(): JSX.Element {
  const [scrolled, setScrolled] = createSignal(false);
  onMount(() => {
    const update = () => setScrolled(window.scrollY > 24);
    update();
    window.addEventListener("scroll", update, { passive: true });
    onCleanup(() => window.removeEventListener("scroll", update));
  });

  return (
    <header class="nav" classList={{ "nav-solid": scrolled() }}>
      <div class="wrap flex h-full items-center gap-2">
        <a
          href="#top"
          class="flex items-center gap-2.5 no-underline text-fg"
          aria-label="Lumen, back to top"
        >
          <Logo size={28} />
          <span class="text-[15px] font-semibold tracking-[-0.01em]">
            Lumen
          </span>
        </a>
        <nav
          class="ml-6 hidden items-center gap-1 md:flex"
          aria-label="Sections"
        >
          <For each={LINKS}>
            {(link) => (
              <a href={link.href} class="nav-link">
                {link.label}
              </a>
            )}
          </For>
        </nav>
        <div class="ml-auto flex items-center gap-1.5">
          <ThemeToggle />
          <Button
            href={REPO_URL}
            external
            leading={<BrandIcon name="github" />}
          >
            <span class="hidden sm:inline">GitHub</span>
            <span class="sr-only sm:hidden">Lumen on GitHub</span>
          </Button>
        </div>
      </div>
    </header>
  );
}
