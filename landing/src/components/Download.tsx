import { ArrowUpRight, Globe, Smartphone } from "lucide-react";
import type { ComponentType, ReactNode, SVGProps } from "react";
import type { RepoInfo } from "../lib/github";
import { spotlight } from "../lib/hooks";
import { MOBILE_README_URL, RELEASES_URL } from "../lib/site";
import { AndroidIcon, AppleIcon, LinuxIcon, WindowsIcon } from "./icons";
import { ButtonLink, SectionHeading, delay } from "./ui";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

function PlatformRow({ icon: I, name, formats, href }: { icon: Icon; name: string; formats: string; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="press group flex items-center gap-3 rounded-lg border border-border bg-background/60 px-3 py-2.5 hover:border-ring/60 hover:bg-accent/50"
    >
      <I className="size-4 text-muted-foreground" />
      <span className="text-sm font-medium">{name}</span>
      <span className="ml-auto font-mono text-[11px] text-muted-foreground">{formats}</span>
      <ArrowUpRight className="size-3.5 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
    </a>
  );
}

function Card({ title, badge, children, stagger = 0 }: { title: string; badge?: ReactNode; children: ReactNode; stagger?: number }) {
  return (
    <div onPointerMove={spotlight} style={delay(stagger)} className="card-surface spotlight reveal flex flex-col rounded-2xl p-6">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold tracking-tight">{title}</h3>
        {badge}
      </div>
      <div className="mt-5 flex flex-1 flex-col gap-2">{children}</div>
    </div>
  );
}

export default function Download({ repo }: { repo: RepoInfo }) {
  const href = repo.release?.url ?? RELEASES_URL;

  return (
    <section id="download" className="relative py-28">
      <div className="mx-auto max-w-6xl px-5">
        <SectionHeading eyebrow="Download">Get the apps.</SectionHeading>

        <div className="mt-16 grid gap-4 lg:grid-cols-3">
          <Card
            title="Desktop"
            badge={
              repo.release && (
                <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                  {repo.release.tag}
                </span>
              )
            }
          >
            <PlatformRow icon={WindowsIcon} name="Windows" formats="installer · portable" href={href} />
            <PlatformRow icon={AppleIcon} name="macOS" formats="universal .dmg" href={href} />
            <PlatformRow icon={LinuxIcon} name="Linux" formats=".AppImage · .deb" href={href} />
            <p className="mt-auto pt-3 text-xs text-muted-foreground">
              Unsigned pre-release builds. Discord Rich Presence and in-app updates on Windows and Linux.
            </p>
          </Card>

          <Card title="Mobile" stagger={80}>
            <PlatformRow icon={AppleIcon} name="iOS" formats="build with EAS" href={MOBILE_README_URL} />
            <PlatformRow icon={AndroidIcon} name="Android" formats="build with EAS" href={MOBILE_README_URL} />
            <p className="mt-auto pt-3 text-xs text-muted-foreground">
              Not in the stores yet. The Expo app builds from source with your own Apple or Google account.
            </p>
          </Card>

          <Card title="Web" stagger={160}>
            <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-6 text-center">
              <span className="grid size-10 place-items-center rounded-full bg-brand-soft text-brand">
                <Globe className="size-5" />
              </span>
              <span className="text-sm font-medium">Already running</span>
              <span className="font-mono text-xs text-muted-foreground">ships with the server</span>
            </div>
            <ButtonLink href="#self-host" variant="outline" size="sm" className="mt-2">
              <Smartphone /> Works in mobile browsers too
            </ButtonLink>
          </Card>
        </div>
      </div>
    </section>
  );
}
