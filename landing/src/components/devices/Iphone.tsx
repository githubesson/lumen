import type { CSSProperties, ReactNode } from "react";

/** Screen area in viewBox units (0 0 440 900). 400×866 matches a 6.1" iPhone's
 *  1179×2556 panel. */
export const IPHONE_SCREEN = { x: 20, y: 17, width: 400, height: 866, radius: 55 };
const VB_W = 440;
const VB_H = 900;

/** Black titanium iPhone, front view. `children` is HTML filling the screen
 *  (clipped to its rounded corners), with the Dynamic Island and a glass glare
 *  drawn on top. Give it a position (relative/absolute) via `className`. Ids are
 *  prefixed with `ip-`, so render at most one per page. */
export default function Iphone({
  children,
  className,
  style,
}: {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const { x, y, width, height, radius } = IPHONE_SCREEN;
  return (
    <div className={className} style={style} role="img" aria-label="Lumen on an iPhone">
      <svg viewBox="0 0 440 900" fill="none" className="block size-full" aria-hidden>
        <defs>
          <linearGradient id="ip-frame" x1="0" y1="0" x2="440" y2="0" gradientUnits="userSpaceOnUse">
            <stop stopColor="#5b5b5f" />
            <stop offset=".012" stopColor="#2b2b2e" />
            <stop offset=".03" stopColor="#1c1c1e" />
            <stop offset=".5" stopColor="#232326" />
            <stop offset=".97" stopColor="#1c1c1e" />
            <stop offset=".988" stopColor="#2b2b2e" />
            <stop offset="1" stopColor="#5b5b5f" />
          </linearGradient>
          <linearGradient id="ip-frame-edge" x1="220" y1="0" x2="220" y2="900" gradientUnits="userSpaceOnUse">
            <stop stopColor="#8a8a8e" />
            <stop offset=".06" stopColor="#3a3a3d" />
            <stop offset=".94" stopColor="#3a3a3d" />
            <stop offset="1" stopColor="#7a7a7e" />
          </linearGradient>
          <linearGradient id="ip-button" x1="0" y1="0" x2="4" y2="0" gradientUnits="userSpaceOnUse">
            <stop stopColor="#6a6a6e" />
            <stop offset=".5" stopColor="#3a3a3d" />
            <stop offset="1" stopColor="#222224" />
          </linearGradient>
          <linearGradient id="ip-glare" x1="20" y1="17" x2="300" y2="600" gradientUnits="userSpaceOnUse">
            <stop stopColor="#fff" stopOpacity=".09" />
            <stop offset=".45" stopColor="#fff" stopOpacity=".02" />
            <stop offset=".46" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <radialGradient
            id="ip-lens"
            cx="0"
            cy="0"
            r="1"
            gradientTransform="translate(262 46.5) scale(7)"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#26324a" />
            <stop offset=".5" stopColor="#0d1320" />
            <stop offset="1" stopColor="#050608" />
          </radialGradient>
        </defs>

        {/* Buttons: action and volume on the left, side button on the right */}
        <rect x="0" y="178" width="5" height="34" rx="2" fill="url(#ip-button)" />
        <rect x="0" y="240" width="5" height="62" rx="2" fill="url(#ip-button)" />
        <rect x="0" y="318" width="5" height="62" rx="2" fill="url(#ip-button)" />
        <rect x="435" y="262" width="5" height="100" rx="2" fill="url(#ip-button)" transform="rotate(180 437.5 312)" />

        {/* Frame, then the black glass border around the display */}
        <rect x="3" y="0.5" width="434" height="899" rx="72" fill="url(#ip-frame)" stroke="url(#ip-frame-edge)" />
        <rect x="7" y="4" width="426" height="892" rx="68.5" fill="#050505" />
        <rect x="7.5" y="4.5" width="425" height="891" rx="68" stroke="#fff" strokeOpacity=".06" />

        <rect x={x} y={y} width={width} height={height} rx={radius} fill="#000" />
      </svg>

      <div
        className="absolute overflow-hidden"
        style={{
          left: `${(x / VB_W) * 100}%`,
          top: `${(y / VB_H) * 100}%`,
          width: `${(width / VB_W) * 100}%`,
          height: `${(height / VB_H) * 100}%`,
          borderRadius: `${(radius / width) * 100}% / ${(radius / height) * 100}%`,
        }}
      >
        {children}
      </div>

      <svg viewBox="0 0 440 900" fill="none" className="pointer-events-none absolute inset-0 size-full" aria-hidden>
        <rect x={x} y={y} width={width} height={height} rx={radius} fill="url(#ip-glare)" />
        {/* Dynamic Island */}
        <rect x="158" y="29" width="124" height="35" rx="17.5" fill="#000" />
        <circle cx="262" cy="46.5" r="6.5" fill="url(#ip-lens)" />
        <circle cx="260" cy="44.5" r="1.4" fill="#6b7da3" opacity=".35" />
      </svg>
    </div>
  );
}
