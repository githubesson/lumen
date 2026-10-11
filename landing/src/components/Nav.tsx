import clsx from "clsx";
import { Menu, Moon, Star, Sun, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { RepoInfo } from "../lib/github";
import type { Theme } from "../lib/hooks";
import { REPO_URL } from "../lib/site";
import { GitHubIcon } from "./icons";
import IconSwap from "./IconSwap";
import Logo from "./Logo";
import { ButtonLink, IconButton } from "./ui";

const LINKS = [
  { href: "#features", label: "Features" },
  { href: "#self-host", label: "Self-host" },
  { href: "#download", label: "Download" },
  { href: "#faq", label: "FAQ" },
];

export default function Nav({
  repo,
  theme,
  onToggleTheme,
}: {
  repo: RepoInfo;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className="fixed inset-x-0 top-0 z-50 px-3 pt-3">
      {/* One panel for the bar and the mobile menu, so the menu opens out of
          the bar instead of floating under it. */}
      <div
        className={clsx(
          "mx-auto max-w-6xl rounded-xl border transition-[background-color,border-color,box-shadow] duration-300",
          open
            ? "border-border bg-background shadow-[var(--shadow-float)]"
            : scrolled
              ? "border-border bg-background/75 shadow-[var(--shadow-float)] backdrop-blur-xl"
              : "border-transparent bg-transparent",
        )}
      >
        <nav className="flex h-13 items-center gap-2 px-3">
          <a href="#top" className="mr-4 rounded-md" aria-label="Lumen home">
            <Logo />
          </a>

          <div className="hidden items-center gap-0.5 md:flex">
            {LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="rounded-md px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              >
                {l.label}
              </a>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="press hidden h-8 items-center gap-2 rounded-lg border border-border px-2.5 text-[13px] hover:bg-accent sm:inline-flex"
            >
              <GitHubIcon className="size-4" />
              <span className="font-medium">GitHub</span>
              {repo.stars !== null && (
                <span className="flex items-center gap-1 border-l border-border pl-2 font-mono text-xs text-muted-foreground">
                  <Star className="size-3" />
                  {repo.stars}
                </span>
              )}
            </a>
            <IconButton
              onClick={onToggleTheme}
              className="press grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
              label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              align="end"
            >
              <IconSwap show={theme === "dark" ? "a" : "b"} a={<Sun className="size-4" />} b={<Moon className="size-4" />} className="size-4" />
            </IconButton>
            <ButtonLink href="#self-host" size="sm" className="max-sm:hidden">
              Get started
            </ButtonLink>
            <IconButton
              onClick={() => setOpen((o) => !o)}
              className="press grid size-8 place-items-center rounded-lg hover:bg-accent"
              label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              align="end"
              wrapperClassName="md:hidden"
            >
              <IconSwap show={open ? "b" : "a"} a={<Menu className="size-4" />} b={<X className="size-4" />} className="size-4" />
            </IconButton>
          </div>
        </nav>

        <div
          className={clsx(
            // Grows the panel downwards. Opening eases out over 250ms; closing
            // is quicker, since the user already decided.
            "grid transition-[grid-template-rows] ease-[var(--ease-out)] motion-reduce:transition-none md:hidden",
            open ? "grid-rows-[1fr] duration-250" : "grid-rows-[0fr] duration-150",
          )}
        >
          {/* Closed: out of the tab order and the accessibility tree, while
              staying mounted so the exit transition can play. */}
          <div className="min-h-0 overflow-hidden" inert={open ? undefined : ""}>
            <div
              className={clsx(
                "mx-3 flex flex-col border-t border-border py-2 transition-[opacity,translate] ease-[var(--ease-out)]",
                open ? "opacity-100 duration-250" : "-translate-y-1 opacity-0 duration-150",
              )}
            >
              {LINKS.map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="press -mx-1 rounded-md px-3 py-2.5 text-sm hover:bg-accent"
                >
                  {l.label}
                </a>
              ))}
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="press -mx-1 flex items-center gap-2 rounded-md px-3 py-2.5 text-sm hover:bg-accent"
              >
                <GitHubIcon className="size-4" /> GitHub
              </a>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
