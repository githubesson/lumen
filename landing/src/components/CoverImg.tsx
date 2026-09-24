import clsx from "clsx";

export default function CoverImg({ src, className }: { src: string; className?: string }) {
  return (
    <img
      src={src}
      alt=""
      decoding="async"
      className={clsx("shrink-0 bg-muted object-cover outline -outline-offset-1 outline-black/10 dark:outline-white/10", className)}
    />
  );
}
