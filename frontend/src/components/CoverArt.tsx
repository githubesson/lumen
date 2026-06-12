import { useEffect, useState } from "react";
import { swatchFor } from "../lib/swatch";

export { swatchFor };

/**
 * CoverArt renders artwork for a track / album / artist tile. If no image is
 * available (or the fetch fails), it falls back to a hash-tinted gradient with
 * the entity's initial — so every tile still looks intentional instead of
 * "broken image" blank.
 */
interface Props {
  /** Image URL to try. If omitted, the placeholder renders immediately. */
  src?: string | null;
  /** Used to generate a stable color for the placeholder. */
  seed: string;
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
  seed,
  label,
  radius,
  size,
  className,
  forcePlaceholder,
  children,
}: Props) {
  const shouldTry = !forcePlaceholder && !!src;
  const [failed, setFailed] = useState(false);

  // Reset the failure flag when the source changes so a new id gets a fresh
  // try instead of being permanently pinned to placeholder.
  useEffect(() => {
    setFailed(false);
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
        className={"cover-art " + (className ?? "")}
        style={{ ...extra, background: swatchFor(seed) }}
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
        className="cover-art-img"
        src={src!}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
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
