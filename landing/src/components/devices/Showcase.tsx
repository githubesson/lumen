import Iphone, { IPHONE_SCREEN } from "./Iphone";
import Macbook, { MACBOOK_SCREEN, MACBOOK_VIEWBOX } from "./Macbook";

// Both themes' screenshots are drawn stacked and swapped with the page theme.
// No cross-fade: every other token changes in one frame, and a slow fade here
// lagged behind the page and double-exposed the two screenshots.
const DARK_ONLY = "opacity-0 dark:opacity-100";
const LIGHT_ONLY = "opacity-100 dark:opacity-0";

// The desktop capture is the Electron window (1280×820), shown floating on a
// wallpaper under a macOS menu bar so the notch sits over the menu bar.
const WINDOW_W = 396;
const WINDOW_H = (WINDOW_W * 820) / 1280;
const MENU_H = MACBOOK_SCREEN.notchBottom - MACBOOK_SCREEN.y + 0.4;
const WINDOW_X = 250 - WINDOW_W / 2;
const WINDOW_Y = MACBOOK_SCREEN.y + MENU_H + 2.2;

// Menu titles with x offsets from the screen edge; ~2.1 units per character
// at this font size, plus a gap.
const MENUS = ["File", "Edit", "View", "Controls", "Window", "Help"].reduce<{ label: string; x: number }[]>(
  (acc, label) => {
    const prev = acc.at(-1);
    return [...acc, { label, x: prev ? prev.x + prev.label.length * 2.1 + 5.5 : 33 }];
  },
  [],
);

function DesktopScreen() {
  const { x, y, width, height } = MACBOOK_SCREEN;
  const textY = y + MENU_H / 2 + 1.5;
  return (
    <>
      <defs>
        <radialGradient
          id="sc-wall-dark"
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(250 380) scale(330 260)"
        >
          <stop stopColor="#4a4a4f" />
          <stop offset=".45" stopColor="#232326" />
          <stop offset="1" stopColor="#0c0c0d" />
        </radialGradient>
        <radialGradient
          id="sc-wall-light"
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(250 380) scale(330 260)"
        >
          <stop stopColor="#c9c9cf" />
          <stop offset=".5" stopColor="#ececef" />
          <stop offset="1" stopColor="#f6f6f7" />
        </radialGradient>
      </defs>

      <rect x={x} y={y} width={width} height={height} fill="url(#sc-wall-light)" className={LIGHT_ONLY} />
      <rect x={x} y={y} width={width} height={height} fill="url(#sc-wall-dark)" className={DARK_ONLY} />

      {/* Menu bar */}
      <rect x={x} y={y} width={width} height={MENU_H} className="fill-white/55 dark:fill-black/35" />
      <g
        className="fill-neutral-900 dark:fill-white"
        fontFamily="-apple-system, 'SF Pro Text', Geist, sans-serif"
        fontSize="4.1"
      >
        <path
          transform={`translate(${x + 6} ${y + 1.9}) scale(0.19)`}
          d="M16.37 12.73c-.02-2.28 1.86-3.38 1.95-3.43-1.06-1.55-2.71-1.77-3.3-1.79-1.4-.14-2.74.83-3.45.83-.71 0-1.81-.81-2.98-.79a4.4 4.4 0 0 0-3.72 2.26c-1.59 2.76-.41 6.84 1.14 9.08.76 1.1 1.66 2.33 2.840 2.29 1.14-.05 1.57-.74 2.95-.74 1.37 0 1.76.74 2.97.71 1.23-.02 2-1.11 2.75-2.22.87-1.27 1.22-2.51 1.24-2.57-.03-.01-2.37-.91-2.39-3.63ZM14.1 6.03c.63-.76 1.05-1.82.93-2.88-.9.04-2 .6-2.65 1.36-.58.67-1.09 1.750-.95 2.78 1 .08 2.03-.51 2.67-1.26Z"
        />
        <text x={x + 15} y={textY} fontWeight="700">
          Lumen
        </text>
        {MENUS.map((m) => (
          <text key={m.label} x={x + m.x} y={textY} opacity=".9">
            {m.label}
          </text>
        ))}
        <text x={x + width - 6} y={textY} textAnchor="end" opacity=".9">
          Thu 24 Sep 21:04
        </text>
      </g>
    </>
  );
}

// Width variants rendered by `npm run screens` (scripts/screens.mjs).
const VARIANTS = import.meta.glob<string>("../../assets/screens/*.webp", { eager: true, import: "default" });

function srcSet(name: string) {
  const entries = Object.entries(VARIANTS)
    .map(([path, url]) => ({ w: Number(path.match(new RegExp(`/${name}-(\\d+)\\.webp$`))?.[1]), url }))
    .filter((e) => e.w)
    .sort((a, b) => a.w - b.w);
  if (!entries.length) return null;
  return { src: entries[entries.length - 1].url, srcSet: entries.map((e) => `${e.url} ${e.w}w`).join(", ") };
}

// Proportions of the scene; everything is placed in % of it, so it reflows
// with the column instead of being scaled as one bitmap (which blurs).
const STAGE_W = 1200;
const STAGE_H = 700;
const MAC_W = 980;
const PHONE_H = 700;
const PHONE_W = (PHONE_H * 440) / 900;

// The stage is the hero column: max-w-6xl minus px-5 on each side.
const STAGE_MAX = 1112;
const sizesFor = (fraction: number) =>
  `(min-width: ${STAGE_MAX + 40}px) ${Math.round(STAGE_MAX * fraction)}px, calc((100vw - 40px) * ${fraction.toFixed(4)})`;
const WINDOW_SIZES = sizesFor((WINDOW_W / MACBOOK_VIEWBOX.width) * (MAC_W / STAGE_W));
const PHONE_SIZES = sizesFor((PHONE_W / STAGE_W) * (IPHONE_SCREEN.width / 440));

/** Renders nothing if the variants haven't been generated (run `npm run screens`). */
function Shot({ name, sizes, className }: { name: string; sizes: string; className: string }) {
  const set = srcSet(name);
  return set && <img {...set} sizes={sizes} alt="" decoding="async" className={className} />;
}

/** The app window as an HTML <img>, positioned over the MacBook in % of its
 *  viewBox so it scales with the frame. */
function DesktopWindow() {
  const vb = MACBOOK_VIEWBOX;
  const img = "absolute inset-0 size-full";
  return (
    <div
      className="absolute overflow-hidden shadow-[0_4px_14px_rgb(0_0_0/0.35)] ring-1 ring-black/15 dark:ring-white/15"
      style={{
        left: `${((WINDOW_X - vb.x) / vb.width) * 100}%`,
        top: `${((WINDOW_Y - vb.y) / vb.height) * 100}%`,
        width: `${(WINDOW_W / vb.width) * 100}%`,
        height: `${(WINDOW_H / vb.height) * 100}%`,
        borderRadius: `${(3.2 / WINDOW_W) * 100}% / ${(3.2 / WINDOW_H) * 100}%`,
      }}
    >
      <Shot name="desktop-light" sizes={WINDOW_SIZES} className={`${img} ${LIGHT_ONLY}`} />
      <Shot name="desktop-dark" sizes={WINDOW_SIZES} className={`${img} ${DARK_ONLY}`} />
    </div>
  );
}

function PhoneScreen() {
  const img = "absolute inset-0 size-full object-cover object-top";
  return (
    <>
      <Shot name="mobile-light" sizes={PHONE_SIZES} className={`${img} ${LIGHT_ONLY}`} />
      <Shot name="mobile-dark" sizes={PHONE_SIZES} className={`${img} ${DARK_ONLY}`} />
    </>
  );
}

// No 3D tilt or scale transforms here: the screenshots must be drawn 1:1 from
// a variant close to their display size, or small text breaks up.
export default function Showcase() {
  return (
    <div className="relative w-full" style={{ aspectRatio: `${STAGE_W} / ${STAGE_H}` }}>
      {/* Contact shadow under the laptop */}
      <div className="absolute bottom-[0.5%] left-[4%] h-[5%] w-[76%] rounded-[50%] bg-black/40 blur-2xl dark:bg-black/80" />
      <Macbook
        className="absolute bottom-0 left-0"
        style={{ width: `${(MAC_W / STAGE_W) * 100}%` }}
        overlay={<DesktopWindow />}
      >
        <DesktopScreen />
      </Macbook>
      <Iphone
        className="absolute bottom-0 right-[0.2%] drop-shadow-[0_30px_40px_rgb(0_0_0/0.45)]"
        style={{ width: `${(PHONE_W / STAGE_W) * 100}%`, height: `${(PHONE_H / STAGE_H) * 100}%` }}
      >
        <PhoneScreen />
      </Iphone>
    </div>
  );
}
