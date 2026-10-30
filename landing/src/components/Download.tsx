import { ArrowUpRight, Globe, Smartphone } from "lucide-react";
import type { ComponentType, ReactNode, SVGProps } from "react";
import type { RepoInfo } from "../lib/github";
import { MOBILE_README_URL, RELEASES_URL } from "../lib/site";
import { AndroidIcon, AppleIcon, LinuxIcon, WindowsIcon } from "./icons";
import { SectionHeading } from "./ui";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const ROW = "flex items-center gap-3 rounded-lg border border-border bg-background/60 px-3 py-2.5";

/** A platform and what you get for it. With `href` it links out to the
 *  download; without, it's a plain row with nothing to fetch. */
function PlatformRow({ icon: I, name, formats, href }: { icon: Icon; name: string; formats: string; href?: string }) {
  const body = (
    <>
      <I className="size-4 text-muted-foreground" />
      <span className="text-sm font-medium">{name}</span>
      <span className="ml-auto font-mono text-[11px] text-muted-foreground">{formats}</span>
    </>
  );
  if (!href) return <div className={ROW}>{body}</div>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className={`press group ${ROW} hover:border-ring/60 hover:bg-accent/50`}>
      {body}
      <ArrowUpRight className="size-3.5 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
    </a>
  );
}

function Card({ title, meta, children, note }: { title: string; meta?: ReactNode; children: ReactNode; note: string }) {
  return (
    <div className="card-surface flex flex-col rounded-2xl p-6">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">{title}</h3>
        {meta}
      </div>
      <div className="mt-5 flex flex-col gap-2">{children}</div>
      <p className="mt-auto pt-5 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

export default function Download({ repo }: { repo: RepoInfo }) {
  const href = repo.release?.url ?? RELEASES_URL;

  return (
    <section id="download" className="relative py-28">
      <div className="reveal mx-auto max-w-6xl px-5">
        <SectionHeading eyebrow="Download">Get the apps</SectionHeading>

        <div className="mt-16 grid gap-4 lg:grid-cols-3">
          <Card
            title="Desktop"
            meta={repo.release && <span className="font-mono text-xs text-muted-foreground">{repo.release.tag}</span>}
            note="Unsigned builds. Discord Rich Presence and in-app updates on Windows and Linux."
          >
            <PlatformRow icon={WindowsIcon} name="Windows" formats="installer · portable" href={href} />
            <PlatformRow icon={AppleIcon} name="macOS" formats="universal .dmg" href={href} />
            <PlatformRow icon={LinuxIcon} name="Linux" formats=".AppImage · .deb" href={href} />
          </Card>

          <Card
            title="Mobile"
            note="Not in the stores yet. The Expo app builds from source with your own Apple or Google account."
          >
            <PlatformRow icon={AppleIcon} name="iOS" formats="build with EAS" href={MOBILE_README_URL} />
            <PlatformRow icon={AndroidIcon} name="Android" formats="build with EAS" href={MOBILE_README_URL} />
          </Card>

          <Card title="Web" note="Nothing to install. Open your server's address on a computer or a phone.">
            <PlatformRow icon={Globe} name="Any browser" formats="ships with the server" />
            <PlatformRow icon={Smartphone} name="Phone browsers" formats="same address" />
          </Card>
        </div>
      </div>
    </section>
  );
}
