import { ArrowRight, Star } from "lucide-react";
import type { RepoInfo } from "../lib/github";
import { INSTALL_STEPS, ISSUES_URL, README_URL, RELEASES_URL, REPO_URL } from "../lib/site";
import { GitHubIcon } from "./icons";
import Logo, { LogoMark } from "./Logo";
import { ButtonLink, CommandPill } from "./ui";

export function FinalCta({ repo }: { repo: RepoInfo }) {
  return (
    <section className="relative overflow-hidden px-5 pb-28">
      <div className="card-surface reveal relative mx-auto max-w-6xl overflow-hidden rounded-3xl px-6 py-20 text-center">
        <div className="bg-grid pointer-events-none absolute inset-0" />
        <div className="glow pointer-events-none absolute left-1/2 top-full h-[420px] w-[900px] -translate-x-1/2 -translate-y-1/2" />
        <div className="relative flex flex-col items-center">
          <LogoMark className="size-14 shadow-lg" />
          <h2 className="text-gradient mt-8 max-w-2xl text-balance text-4xl font-semibold tracking-[-0.035em] sm:text-5xl">
            Own your music again.
          </h2>
          <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row">
            <ButtonLink href="#self-host" size="lg">
              Get started <ArrowRight />
            </ButtonLink>
            <ButtonLink href={REPO_URL} size="lg" variant="outline">
              <GitHubIcon /> Star on GitHub
              {repo.stars !== null && (
                <span className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
                  <Star className="size-3" />
                  {repo.stars}
                </span>
              )}
            </ButtonLink>
          </div>
          <CommandPill command={INSTALL_STEPS[2].cmd} className="mt-4" />
        </div>
      </div>
    </section>
  );
}

const COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "#features" },
      { label: "Download", href: "#download" },
    ],
  },
  {
    title: "Self-host",
    links: [
      { label: "Setup guide", href: README_URL },
      { label: "Releases", href: RELEASES_URL },
      { label: "FAQ", href: "#faq" },
    ],
  },
  {
    title: "Community",
    links: [
      { label: "GitHub", href: REPO_URL },
      { label: "Issues", href: ISSUES_URL },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:grid-cols-[1.5fr_repeat(3,1fr)]">
        <div className="flex flex-col gap-4">
          <Logo />
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-success" />
            Self-hosted. No accounts with us, no ads.
          </span>
        </div>
        {COLUMNS.map((c) => (
          <div key={c.title} className="flex flex-col gap-3">
            <span className="text-xs font-medium text-muted-foreground">{c.title}</span>
            {c.links.map((l) => (
              <a
                key={l.label}
                href={l.href}
                {...(l.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
                className="text-sm text-foreground/80 transition-colors hover:text-foreground"
              >
                {l.label}
              </a>
            ))}
          </div>
        ))}
      </div>
      <div className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-5 py-6 font-mono text-[11px] text-muted-foreground">
          <span>© {new Date().getFullYear()} Lumen</span>
          <span>Made for people who still keep their music in folders.</span>
        </div>
      </div>
    </footer>
  );
}
