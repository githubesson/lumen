import { useLayoutEffect, useRef, useState } from "react";
/**
 * CoverArt renders artwork for a track / album / artist tile. If no image is
 * available (or the fetch fails), it falls back to a muted placeholder with
 * the entity's initial — so every tile still looks intentional instead of
 * "broken image" blank.
 */
interface Props {
  /** Image URL to try. If omitted, the placeholder renders immediately. */
  src?: string | null;
  /** First letter shown on the placeholder. */
  label: string;
  /** Corner radius. Defaults to the card radius; pass 999 for circular. */
  radius?: number | string;
  /** Square size preset. The CSS .card-art is 1:1 by default. */
  size?: number;
  className?: string;
  /** If true, the placeholder is rendered without ever trying the URL. */
  forcePlaceholder?: boolean;
  children?: React.ReactNode;
}

export default function CoverArt({
  src,
  label,
  radius,
  size,
  className,
  forcePlaceholder,
  children,
}: Props) {
  const shouldTry = !forcePlaceholder && !!src;
  // Remember which source failed rather than resetting state from an effect.
  // A different source naturally gets a fresh attempt.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === src;

  // Cached images are already complete before React attaches onLoad, so seed
  // the flag from the element itself — otherwise every cached cover would
  // re-fade on each mount while scrolling a virtualised list.
  // Tracked by source, like failedSrc above, so a new source starts unloaded
  // without resetting state from an effect.
  const imgRef = useRef<HTMLImageElement>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const loaded = loadedSrc === src;

  useLayoutEffect(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth > 0) setLoadedSrc(src ?? null);
  }, [src]);

  const placeholder = !shouldTry || failed;

  // Only set inline styles the CSS class can't already provide. For the common
  // `.card-art` / `.mini-art` case we leave layout entirely to the class
  // (which uses `aspect-ratio` / fixed sizes) so aspect-ratio actually
  // computes a height.
  const extra: React.CSSProperties = {};
  if (radius !== undefined) extra.borderRadius = radius;
  if (size !== undefined) {
    extra.width = size;
    extra.height = size;
    extra.flex = `0 0 ${size}px`;
  }

  if (placeholder) {
    return (
      <div
        className={"cover-art cover-art-placeholder " + (className ?? "")}
        style={extra}
        aria-hidden="true"
      >
        <span className="cover-art-letter">{firstLetter(label)}</span>
        {children}
      </div>
    );
  }

  return (
    <div className={"cover-art " + (className ?? "")} style={extra}>
      <img
        key={src}
        ref={imgRef}
        className="cover-art-img"
        src={src!}
        alt=""
        loading="lazy"
        decoding="async"
        data-loaded={loaded || undefined}
        onLoad={() => setLoadedSrc(src ?? null)}
        onError={() => setFailedSrc(src ?? null)}
      />
      {children}
    </div>
  );
}

function firstLetter(s: string) {
  const t = s.trim();
  if (!t) return "?";
  return t[0].toLocaleUpperCase();
}
