import { Globe } from "lucide-react";
import { AndroidIcon, AppleIcon, LinuxIcon, WindowsIcon } from "./icons";
import { delay } from "./ui";

const PLATFORMS = [
  { icon: Globe, label: "Web" },
  { icon: WindowsIcon, label: "Windows" },
  { icon: AppleIcon, label: "macOS" },
  { icon: LinuxIcon, label: "Linux" },
  { icon: AppleIcon, label: "iOS" },
  { icon: AndroidIcon, label: "Android" },
];

const STACK = ["Go", "Postgres", "React", "Electron", "Expo", "Docker"];

export default function Platforms() {
  return (
    <section className="border-y border-border bg-sidebar/50">
      <div className="mx-auto grid max-w-6xl items-center gap-8 px-5 py-10 md:grid-cols-[1fr_auto_1fr]">
        <div className="reveal flex flex-col gap-3">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">One server, every screen</span>
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            {PLATFORMS.map(({ icon: I, label }) => (
              <span key={label} className="flex items-center gap-2 text-sm text-foreground/80">
                <I className="size-4 text-muted-foreground" />
                {label}
              </span>
            ))}
          </div>
        </div>
        <div className="hidden h-10 w-px bg-border md:block" />
        <div className="reveal flex flex-col gap-3 md:items-end" style={delay(100)}>
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Built with</span>
          <div className="flex flex-wrap gap-2">
            {STACK.map((s) => (
              <span key={s} className="rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-muted-foreground">
                {s}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
