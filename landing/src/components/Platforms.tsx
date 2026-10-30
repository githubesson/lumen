import { Globe } from "lucide-react";
import { AndroidIcon, AppleIcon, LinuxIcon, WindowsIcon } from "./icons";

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
      <div className="reveal mx-auto grid max-w-6xl items-center gap-8 px-5 py-10 md:grid-cols-[1fr_auto_1fr]">
        <div className="flex flex-col gap-3">
          <span className="text-[13px] text-muted-foreground">One server, every screen</span>
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
        <div className="flex flex-col gap-3 md:items-end">
          <span className="text-[13px] text-muted-foreground">Built with</span>
          <div className="flex flex-wrap gap-x-5 gap-y-3 text-sm text-foreground/80">
            {STACK.map((s) => (
              <span key={s}>{s}</span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
