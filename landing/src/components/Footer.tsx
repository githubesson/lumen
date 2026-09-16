import { For, type JSX } from "solid-js";
import { Logo } from "./Logo";
import { DOCS, RELEASES_URL, REPO_URL } from "../lib/site";

const COLUMNS: Array<{
  title: string;
  links: Array<{ href: string; label: string }>;
}> = [
  {
    title: "Project",
    links: [
      { href: REPO_URL, label: "GitHub" },
      { href: RELEASES_URL, label: "Releases" },
      { href: DOCS.issues, label: "Issues" },
    ],
  },
  {
    title: "Docs",
    links: [
      { href: DOCS.runIt, label: "Run it" },
      { href: DOCS.frontend, label: "Web and desktop" },
      { href: DOCS.mobile, label: "Mobile" },
      { href: DOCS.nginx, label: "Reverse proxy" },
    ],
  },
];

export function Footer(): JSX.Element {
  return (
    <footer class="border-t border-line-soft">
      <div class="wrap flex flex-col gap-10 py-14 md:flex-row md:justify-between">
        <div class="flex max-w-xs flex-col gap-3">
          <div class="flex items-center gap-2.5">
            <Logo size={26} />
            <span class="text-[15px] font-semibold tracking-[-0.01em]">
              Lumen
            </span>
          </div>
          <p class="body">
            Self-hosted, invite-only music library with web, desktop, and mobile
            clients.
          </p>
        </div>
        <div class="grid grid-cols-2 gap-10 sm:gap-16">
          <For each={COLUMNS}>
            {(column) => (
              <div class="flex flex-col gap-3">
                <p class="eyebrow">{column.title}</p>
                <ul class="m-0 flex list-none flex-col gap-2 p-0">
                  <For each={column.links}>
                    {(link) => (
                      <li>
                        <a
                          href={link.href}
                          target="_blank"
                          rel="noreferrer"
                          class="text-sm text-muted no-underline hover:text-fg"
                        >
                          {link.label}
                        </a>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            )}
          </For>
        </div>
      </div>
      <div class="wrap flex flex-col gap-2 border-t border-line-soft py-6 text-[13px] text-subtle sm:flex-row sm:justify-between">
        <p class="m-0">Built with Go, React, Expo, and SolidJS.</p>
        {/* TODO: link the license once a LICENSE file lands in the repo. */}
        <p class="m-0">Source on GitHub.</p>
      </div>
    </footer>
  );
}
