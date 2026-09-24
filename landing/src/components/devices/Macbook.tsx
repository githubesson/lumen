import type { CSSProperties, ReactNode } from "react";

/** The viewBox, and the screen area inside the lid, in viewBox units. */
export const MACBOOK_VIEWBOX = { x: 0, y: 95, width: 500, height: 310 };
export const MACBOOK_SCREEN = { x: 44.4, y: 103.15, width: 411.2, height: 266.75, notchBottom: 111 };

/** Space black MacBook Pro, front view (vector). `children` is SVG drawn on
 *  the screen under the notch; `overlay` is HTML laid over the whole device,
 *  for raster content that should go through the browser's image pipeline
 *  (SVG <image> downsamples poorly). Give it a position via `className`. Ids
 *  are prefixed with `mb-`, so render at most one per page. */
export default function Macbook({
  children,
  overlay,
  className,
  style,
}: {
  children?: ReactNode;
  overlay?: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={className} style={style}>
      <svg
        viewBox="0 95 500 310"
        fill="none"
        className="block h-auto w-full"
        role="img"
        aria-label="Lumen on a MacBook Pro"
      >
        <defs>
          <linearGradient id="mb-lid-metal" x1="39.2" y1="230" x2="460.8" y2="230" gradientUnits="userSpaceOnUse">
            <stop stopColor="#575859" />
            <stop offset=".007" stopColor="#282929" />
            <stop offset=".017" stopColor="#151617" />
            <stop offset=".055" stopColor="#2c2d2d" />
            <stop offset=".48" stopColor="#393a3a" />
            <stop offset=".93" stopColor="#252627" />
            <stop offset=".989" stopColor="#202122" />
            <stop offset="1" stopColor="#565758" />
          </linearGradient>
          <linearGradient id="mb-lid-edge" x1="250" y1="97.7" x2="250" y2="382.8" gradientUnits="userSpaceOnUse">
            <stop stopColor="#777878" />
            <stop offset=".018" stopColor="#343536" />
            <stop offset=".10" stopColor="#1c1d1d" />
            <stop offset=".91" stopColor="#202121" />
            <stop offset="1" stopColor="#4c4d4d" />
          </linearGradient>
          <linearGradient id="mb-glass-bezel" x1="250" y1="99.2" x2="250" y2="381.9" gradientUnits="userSpaceOnUse">
            <stop stopColor="#070808" />
            <stop offset=".47" stopColor="#020303" />
            <stop offset=".94" stopColor="#050606" />
            <stop offset="1" stopColor="#0c0d0d" />
          </linearGradient>
          <linearGradient id="mb-screen-black" x1="250" y1="103.4" x2="250" y2="369.8" gradientUnits="userSpaceOnUse">
            <stop stopColor="#090a0c" />
            <stop offset=".48" stopColor="#060709" />
            <stop offset="1" stopColor="#030405" />
          </linearGradient>
          <radialGradient
            id="mb-screen-reflection"
            cx="0"
            cy="0"
            r="1"
            gradientTransform="translate(118 104) rotate(38) scale(452 307)"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#2c3038" stopOpacity=".09" />
            <stop offset=".68" stopColor="#14171c" stopOpacity=".025" />
            <stop offset="1" stopColor="#000" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="mb-lower-bezel" x1="250" y1="369.8" x2="250" y2="382.6" gradientUnits="userSpaceOnUse">
            <stop stopColor="#050606" />
            <stop offset=".18" stopColor="#111212" />
            <stop offset=".38" stopColor="#141515" />
            <stop offset=".82" stopColor="#0b0c0c" />
            <stop offset="1" stopColor="#030404" />
          </linearGradient>
          <linearGradient id="mb-base-metal" x1="250" y1="383" x2="250" y2="400.45" gradientUnits="userSpaceOnUse">
            <stop stopColor="#777679" />
            <stop offset=".065" stopColor="#5d5c5f" />
            <stop offset=".24" stopColor="#565558" />
            <stop offset=".43" stopColor="#4c4b4e" />
            <stop offset=".65" stopColor="#39383b" />
            <stop offset=".79" stopColor="#29292c" />
            <stop offset=".88" stopColor="#2c2c2e" />
            <stop offset=".965" stopColor="#535356" />
            <stop offset="1" stopColor="#38383a" />
          </linearGradient>
          <linearGradient id="mb-base-wide-light" x1="0" y1="391" x2="500" y2="391" gradientUnits="userSpaceOnUse">
            <stop stopColor="#030305" stopOpacity=".26" />
            <stop offset=".12" stopColor="#0a0a0d" stopOpacity=".06" />
            <stop offset=".38" stopColor="#e3e1e8" stopOpacity=".03" />
            <stop offset=".65" stopColor="#e3e1e8" stopOpacity=".065" />
            <stop offset=".9" stopColor="#000" stopOpacity=".025" />
            <stop offset="1" stopColor="#000" stopOpacity=".24" />
          </linearGradient>
          <linearGradient id="mb-left-metal-roll" x1="1.2" y1="390" x2="13.8" y2="390" gradientUnits="userSpaceOnUse">
            <stop stopColor="#636367" />
            <stop offset=".12" stopColor="#a4a4a6" />
            <stop offset=".24" stopColor="#8c8c8e" />
            <stop offset=".43" stopColor="#646467" />
            <stop offset=".58" stopColor="#3a3a3e" />
            <stop offset=".81" stopColor="#2c2c30" stopOpacity=".78" />
            <stop offset="1" stopColor="#37373b" stopOpacity="0" />
          </linearGradient>
          <linearGradient
            id="mb-right-metal-roll"
            x1="498.8"
            y1="390"
            x2="486.2"
            y2="390"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#6d6d70" />
            <stop offset=".12" stopColor="#a0a0a2" />
            <stop offset=".24" stopColor="#8b8b8e" />
            <stop offset=".43" stopColor="#626265" />
            <stop offset=".58" stopColor="#353539" />
            <stop offset=".81" stopColor="#29292d" stopOpacity=".75" />
            <stop offset="1" stopColor="#353539" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="mb-lip-edge" x1="13" y1="383" x2="487" y2="383" gradientUnits="userSpaceOnUse">
            <stop stopColor="#858588" stopOpacity=".55" />
            <stop offset=".2" stopColor="#aaa9ac" stopOpacity=".65" />
            <stop offset=".5" stopColor="#c3c2c5" stopOpacity=".7" />
            <stop offset=".8" stopColor="#aaa9ac" stopOpacity=".65" />
            <stop offset="1" stopColor="#858588" stopOpacity=".55" />
          </linearGradient>
          <linearGradient id="mb-opening-recess" x1="250" y1="383.3" x2="250" y2="390.8" gradientUnits="userSpaceOnUse">
            <stop stopColor="#151518" />
            <stop offset=".42" stopColor="#38383b" />
            <stop offset="1" stopColor="#565558" />
          </linearGradient>
          <linearGradient id="mb-opening-bevel" x1="250" y1="383.4" x2="250" y2="390" gradientUnits="userSpaceOnUse">
            <stop stopColor="#98989b" />
            <stop offset=".2" stopColor="#929295" />
            <stop offset=".48" stopColor="#828285" />
            <stop offset=".76" stopColor="#68686c" />
            <stop offset="1" stopColor="#49494d" />
          </linearGradient>
          <linearGradient id="mb-opening-side" x1="212" y1="387" x2="288" y2="387" gradientUnits="userSpaceOnUse">
            <stop stopColor="#151519" stopOpacity=".95" />
            <stop offset=".045" stopColor="#151519" stopOpacity=".1" />
            <stop offset=".13" stopColor="#fff" stopOpacity="0" />
            <stop offset=".87" stopColor="#fff" stopOpacity="0" />
            <stop offset=".955" stopColor="#151519" stopOpacity=".1" />
            <stop offset="1" stopColor="#151519" stopOpacity=".95" />
          </linearGradient>
          <linearGradient id="mb-foot-rubber" x1="0" y1="399.7" x2="0" y2="403" gradientUnits="userSpaceOnUse">
            <stop stopColor="#19191b" />
            <stop offset=".6" stopColor="#3e3e40" />
            <stop offset="1" stopColor="#565657" />
          </linearGradient>
          <radialGradient id="mb-camera-lens">
            <stop stopColor="#252b30" />
            <stop offset=".45" stopColor="#111820" />
            <stop offset=".7" stopColor="#151819" />
            <stop offset="1" stopColor="#030404" />
          </radialGradient>
          <clipPath id="mb-screen-clip">
            <path d="M52 103.15H448C452.75 103.15 455.6 106.1 455.6 111.15V369.9H44.4V111.15C44.4 106.1 47.25 103.15 52 103.15Z" />
          </clipPath>
          <clipPath id="mb-base-clip">
            <path d="M1.05 383H498.95V391.45C498.95 397.15 495.8 400.3 489.9 400.3H10.1C4.2 400.3 1.05 397.15 1.05 391.45V383Z" />
          </clipPath>
        </defs>
        {/* The reference is viewed directly from the front: the keyboard deck is edge-on. */}
        <g>
          <path
            d="M51.45 97.65H448.55C456.9 97.65 460.7 101.8 460.7 111.05V382.9H39.3V111.05C39.3 101.8 43.1 97.65 51.45 97.65Z"
            fill="url(#mb-lid-metal)"
            stroke="url(#mb-lid-edge)"
            strokeWidth=".7"
          />
          <path
            d="M51.8 99.25H448.2C455.65 99.25 459.1 102.95 459.1 111.4V382.15H40.9V111.4C40.9 102.95 44.35 99.25 51.8 99.25Z"
            fill="url(#mb-glass-bezel)"
          />
          <path
            d="M40.15 381.4V112.3C40.15 103.85 43.05 99.05 50.85 98.65"
            stroke="#909292"
            strokeOpacity=".23"
            strokeWidth=".55"
          />
          <path
            d="M459.85 380.9V111.7C459.85 103.6 456.85 99.1 449.15 98.65"
            stroke="#9a9b9b"
            strokeOpacity=".15"
            strokeWidth=".55"
          />
          <path d="M51.5 98.55H448.5" stroke="#999a9a" strokeOpacity=".19" strokeWidth=".45" />
        </g>
        <g clipPath="url(#mb-screen-clip)">
          <path d="M44.4 103.15H455.6V369.9H44.4Z" fill="url(#mb-screen-black)" />
          {children}
          {/* Faint glass reflection over whatever is on screen. */}
          <path d="M44.4 103.15H455.6V369.9H44.4Z" fill="url(#mb-screen-reflection)" pointerEvents="none" />
        </g>
        <g>
          <path
            d="M228.35 102.55H271.65V108.7C271.65 110.25 270.9 111 269.35 111H230.65C229.1 111 228.35 110.25 228.35 108.7V102.55Z"
            fill="#020303"
          />
          <circle cx="250" cy="106.5" r="1.28" fill="#050607" />
          <circle cx="250" cy="106.5" r=".87" fill="url(#mb-camera-lens)" />
          <ellipse cx="249.79" cy="106.25" rx=".25" ry=".16" fill="#606771" opacity=".22" />
        </g>
        <g>
          <path d="M41.65 369.9H458.35V382.55H41.65Z" fill="url(#mb-lower-bezel)" />
          <path d="M43.2 372.2H456.8" stroke="#3b3c3c" strokeOpacity=".2" strokeWidth=".6" />
          <path d="M42.2 381.6H457.8" stroke="#393a3b" strokeOpacity=".38" strokeWidth=".65" />
          <path d="M43 382.55H457" stroke="#000" strokeWidth=".8" />
        </g>

        <g>
          <path
            d="M23.2 399.6H54.65L52.8 401.5C52.2 402.2 51.1 402.65 49.3 402.65H28.55C26.95 402.65 25.7 402.2 25.15 401.5L23.2 399.6Z"
            fill="url(#mb-foot-rubber)"
          />
          <path
            d="M445.35 399.6H476.8L474.85 401.5C474.3 402.2 473.05 402.65 471.45 402.65H450.7C448.9 402.65 447.8 402.2 447.2 401.5L445.35 399.6Z"
            fill="url(#mb-foot-rubber)"
          />
        </g>
        <g>
          <path
            d="M1.05 383H498.95V391.45C498.95 397.15 495.8 400.3 489.9 400.3H10.1C4.2 400.3 1.05 397.15 1.05 391.45V383Z"
            fill="url(#mb-base-metal)"
            stroke="#48484b"
            strokeWidth=".5"
            strokeLinejoin="round"
          />
          <g clipPath="url(#mb-base-clip)">
            <path d="M0 382.5H500V401H0Z" fill="url(#mb-base-wide-light)" />
            <path d="M1.2 383H14V400.3H1.2Z" fill="url(#mb-left-metal-roll)" />
            <path d="M486 383H498.8V400.3H486Z" fill="url(#mb-right-metal-roll)" />
            <path
              d="M8.1 383.8V391.9C8.1 396.35 9.25 398.25 13.45 398.4H486.55C490.75 398.25 491.9 396.35 491.9 391.9V383.8"
              stroke="#111115"
              strokeOpacity=".3"
              strokeWidth=".65"
            />
            <path d="M11.5 399.25H488.5" stroke="#8b8b8e" strokeOpacity=".3" strokeWidth=".55" />
            <path d="M16 396.9H484" stroke="#222226" strokeOpacity=".28" strokeWidth=".55" />
          </g>
          <path d="M2 383.1H498" stroke="url(#mb-lip-edge)" strokeWidth=".65" />
          <g>
            <path
              d="M211.35 383.28H288.65L287.2 387.45C286.5 389.48 285.4 390.15 282.5 390.15H217.5C214.6 390.15 213.5 389.48 212.8 387.45L211.35 383.28Z"
              fill="url(#mb-opening-recess)"
            />
            <path
              d="M214.05 383.55H285.95L285.12 387.05C284.81 388.35 283.84 389.2 281.76 389.2H218.24C216.16 389.2 215.19 388.35 214.88 387.05L214.05 383.55Z"
              fill="url(#mb-opening-bevel)"
            />
            <path
              d="M211.35 383.28H288.65L287.2 387.45C286.5 389.48 285.4 390.15 282.5 390.15H217.5C214.6 390.15 213.5 389.48 212.8 387.45L211.35 383.28Z"
              fill="url(#mb-opening-side)"
            />
            <path d="M215 383.62H285" stroke="#b8b8bb" strokeOpacity=".5" strokeWidth=".45" />
          </g>
        </g>
      </svg>
      {overlay}
    </div>
  );
}
