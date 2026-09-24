import { ArrowRight, Download } from "lucide-react";
import type { RepoInfo } from "../lib/github";
import { INSTALL_STEPS, RELEASES_URL } from "../lib/site";
import Showcase from "./devices/Showcase";
import { ButtonLink, CommandPill, delay } from "./ui";

export default function Hero({ repo }: { repo: RepoInfo }) {
  const release = repo.release;

  return (
    <section id="top" className="relative overflow-hidden pb-24 pt-36 sm:pt-44">
      <div className="bg-grid pointer-events-none absolute inset-0 -z-10" />
      <div className="glow pointer-events-none absolute left-1/2 top-[520px] -z-10 h-[640px] w-[1100px] -translate-x-1/2" />

      <div className="mx-auto flex max-w-6xl flex-col items-center px-5 text-center">
        <a
          href={release?.url ?? RELEASES_URL}
          target="_blank"
          rel="noreferrer"
          className="enter press group inline-flex items-center gap-2 rounded-full border border-border bg-background/60 py-1 pl-1 pr-3 text-[13px] backdrop-blur hover:border-ring/60"
        >
          <span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand">
            {release?.prerelease ? "Pre-release" : "New"}
          </span>
          <span className="text-muted-foreground">
            {release ? (
              <>
                Lumen <span className="font-mono text-foreground">{release.tag.replace(/^v/, "")}</span> is out
              </>
            ) : (
              "Free, open source, self-hosted"
            )}
          </span>
          <ArrowRight className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </a>

        <h1
          className="enter text-gradient mt-7 max-w-4xl text-balance text-5xl font-semibold leading-[1.02] tracking-[-0.045em] sm:text-7xl"
          style={delay(80)}
        >
          Your music library, <span className="text-brand-gradient">on your own server.</span>
        </h1>

        <div
          className="enter mt-10 flex flex-col items-center gap-3 sm:flex-row"
          style={delay(160)}
        >
          <ButtonLink href="#self-host" size="lg">
            Self-host in 5 minutes <ArrowRight />
          </ButtonLink>
          <ButtonLink href="#download" size="lg" variant="outline">
            <Download /> Get the apps
          </ButtonLink>
        </div>
        <CommandPill command={INSTALL_STEPS[2].cmd} className="enter mt-4" style={delay(220)} />
      </div>

      <div className="enter-plain mx-auto mt-16 max-w-6xl px-5" style={delay(320)}>
        <Showcase />
      </div>
    </section>
  );
}
