import clsx from "clsx";
import { WaveformGlyph } from "./icons";

/** App icon: the waveform from resources/icon.icon on a graphite tile. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      className={clsx(
        "inline-grid shrink-0 place-items-center rounded-[28%] text-white shadow-[inset_0_1px_0_oklch(1_0_0/0.25)]",
        className ?? "size-7",
      )}
      style={{ background: "linear-gradient(180deg, oklch(0.42 0 0) 0%, oklch(0.18 0 0) 80%)" }}
    >
      <WaveformGlyph className="w-[74%] opacity-90" />
    </span>
  );
}

export default function Logo({ className }: { className?: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-2", className)}>
      <LogoMark />
      <span className="text-[15px] font-semibold tracking-tight">Lumen</span>
    </span>
  );
}
