import type { JSX } from "solid-js";

// A front-view space black MacBook Pro, generated from
// assets/macbook-pro-front.svg. The screen area below the notch band is
// punched out of the frame with a mask so the DOM layer underneath shows
// through; children fill that layer with an <img>, <picture>, or <video>.
// The mask region is spelled out because the viewBox starts at y=95 and the
// default region would clip the lower part of the lid.
// The band beside the notch stays black, as macOS shows it in full screen.
// Ids are prefixed, so keep to one instance per page. Sizing comes from the
// wrapper's width; the aspect ratio is fixed at 500:310.

const SCREEN_STYLE: JSX.CSSProperties = {
  left: `${(44.4 / 500) * 100}%`,
  top: `${((111 - 95) / 310) * 100}%`,
  width: `${(411.2 / 500) * 100}%`,
  height: `${((369.9 - 111) / 310) * 100}%`,
};

export function Macbook(props: {
  class?: string;
  style?: JSX.CSSProperties;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <div
      class={`macbook ${props.class ?? ""}`}
      style={{ "aspect-ratio": "500 / 310", ...props.style }}
    >
      <div class="macbook-screen" style={SCREEN_STYLE}>
        {props.children}
      </div>
      <svg
        viewBox="0 95 500 310"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        class="macbook-svg"
        aria-hidden="true"
      >
        <defs>
          <linearGradient
            id="mb-lid-metal"
            x1="39.2"
            y1="230"
            x2="460.8"
            y2="230"
            gradientUnits="userSpaceOnUse"
          >
            <stop stop-color="#575859" />
            <stop offset=".007" stop-color="#282929" />
            <stop offset=".017" stop-color="#151617" />
            <stop offset=".055" stop-color="#2c2d2d" />
            <stop offset=".48" stop-color="#393a3a" />
            <stop offset=".93" stop-color="#252627" />
            <stop offset=".989" stop-color="#202122" />
            <stop offset="1" stop-color="#565758" />
          </linearGradient>
          <linearGradient
            id="mb-lid-edge"
            x1="250"
            y1="97.7"
            x2="250"
            y2="382.8"
            gradientUnits="userSpaceOnUse"
          >
            <stop stop-color="#777878" />
            <stop offset=".018" stop-color="#343536" />
            <stop offset=".10" stop-color="#1c1d1d" />
            <stop offset=".91" stop-color="#202121" />
            <stop offset="1" stop-color="#4c4d4d" />
          </linearGradient>
          <linearGradient
            id="mb-glass-bezel"
            x1="250"
            y1="99.2"
            x2="250"
            y2="381.9"
            gradientUnits="userSpaceOnUse"
          >
            <stop stop-color="#070808" />
            <stop offset=".47" stop-color="#020303" />
            <stop offset=".94" stop-color="#050606" />
            <stop offset="1" stop-color="#0c0d0d" />
          </linearGradient>
          <linearGradient
            id="mb-screen-black"
            x1="250"
            y1="103.4"
            x2="250"
            y2="369.8"
            gradientUnits="userSpaceOnUse"
          >
            <stop stop-color="#090a0c" />
            <stop offset=".48" stop-color="#060709" />
            <stop offset="1" stop-color="#030405" />
          </linearGradient>
          <radialGradient
            id="mb-screen-reflection"
            cx="0"
            cy="0"
            r="1"
            gradientTransform="translate(118 104) rotate(38) scale(452 307)"
            gradientUnits="userSpaceOnUse"
          >
            <stop stop-color="#2c3038" stop-opacity=".09" />
            <stop offset=".68" stop-color="#14171c" stop-opacity=".025" />
            <stop offset="1" stop-color="#000" stop-opacity="0" />
          </radialGradient>
          <linearGradient
            id="mb-lower-bezel"
            x1="250"
            y1="369.8"
            x2="250"
            y2="382.6"
            gradientUnits="userSpaceOnUse"
          >
            <stop stop-color="#050606" />
            <stop offset=".18" stop-color="#111212" />
            <stop offset=".38" stop-color="#141515" />
            <stop offset=".82" stop-color="#0b0c0c" />
            <stop offset="1" stop-color="#030404" />
          </linearGradient>
          <linearGradient
            id="mb-base-metal"
            x1="250"
            y1="383"
            x2="250"
            y2="400.45"
            gradientUnits="userSpaceOnUse"
          >
            <stop stop-color="#777679" />
            <stop offset=".065" stop-color="#5d5c5f" />
            <stop offset=".24" stop-color="#565558" />
            <stop offset=".43" stop-color="#4c4b4e" />
            <stop offset=".65" stop-color="#39383b" />
            <stop offset=".79" stop-color="#29292c" />
            <stop offset=".88" stop-color="#2c2c2e" />
            <stop offset=".965" stop-color="#535356" />
            <stop offset="1" stop-color="#38383a" />
          </linearGradient>
          <linearGradient
            id="mb-base-wide-light"
            x1="0"
            y1="391"
            x2="500"
            y2="391"
            gradientUnits="userSpaceOnUse"
          >
            <stop stop-color="#030305" stop-opacity=".26" />
            <stop offset=".12" stop-color="#0a0a0d" stop-opacity=".06" />
            <stop offset=".38" stop-color="#e3e1e8" stop-opacity=".03" />
            <stop offset=".65" stop-color="#e3e1e8" stop-opacity=".065" />
            <stop offset=".9" stop-color="#000" stop-opacity=".025" />
            <stop offset="1" stop-color="#000" stop-opacity=".24" />
          </linearGradient>
          <linearGradient
            id="mb-left-metal-roll"
            x1="1.2"
            y1="390"
            x2="13.8"
            y2="390"
            gradientUnits="userSpaceOnUse"
          >
            <stop stop-color="#636367" />
            <stop offset=".12" stop-color="#a4a4a6" />
            <stop offset=".24" stop-color="#8c8c8e" />
            <stop offset=".43" stop-color="#646467" />
            <stop offset=".58" stop-color="#3a3a3e" />
            <stop offset=".81" stop-color="#2c2c30" stop-opacity=".78" />
            <stop offset="1" stop-color="#37373b" stop-opacity="0" />
          </linearGradient>
          <linearGradient
            id="mb-right-metal-roll"
            x1="498.8"
            y1="390"
            x2="486.2"
            y2="390"
            gradientUnits="userSpaceOnUse"
          >
            <stop stop-color="#6d6d70" />
            <stop offset=".12" stop-color="#a0a0a2" />
            <stop offset=".24" stop-color="#8b8b8e" />
            <stop offset=".43" stop-color="#626265" />
            <stop offset=".58" stop-color="#353539" />
            <stop offset=".81" stop-color="#29292d" stop-opacity=".75" />
            <stop offset="1" stop-color="#353539" stop-opacity="0" />
          </linearGradient>
          <linearGradient
            id="mb-lip-edge"
            x1="13"
            y1="383"
            x2="487"
            y2="383"
            gradientUnits="userSpaceOnUse"
          >
            <stop stop-color="#858588" stop-opacity=".55" />
            <stop offset=".2" stop-color="#aaa9ac" stop-opacity=".65" />
            <stop offset=".5" stop-color="#c3c2c5" stop-opacity=".7" />
            <stop offset=".8" stop-color="#aaa9ac" stop-opacity=".65" />
            <stop offset="1" stop-color="#858588" stop-opacity=".55" />
          </linearGradient>
          <linearGradient
            id="mb-opening-recess"
            x1="250"
            y1="383.3"
            x2="250"
            y2="390.8"
            gradientUnits="userSpaceOnUse"
          >
            <stop stop-color="#151518" />
            <stop offset=".42" stop-color="#38383b" />
            <stop offset="1" stop-color="#565558" />
          </linearGradient>
          <linearGradient
            id="mb-opening-bevel"
            x1="250"
            y1="383.4"
            x2="250"
            y2="390"
            gradientUnits="userSpaceOnUse"
          >
            <stop stop-color="#98989b" />
            <stop offset=".2" stop-color="#929295" />
            <stop offset=".48" stop-color="#828285" />
            <stop offset=".76" stop-color="#68686c" />
            <stop offset="1" stop-color="#49494d" />
          </linearGradient>
          <linearGradient
            id="mb-opening-side"
            x1="212"
            y1="387"
            x2="288"
            y2="387"
            gradientUnits="userSpaceOnUse"
          >
            <stop stop-color="#151519" stop-opacity=".95" />
            <stop offset=".045" stop-color="#151519" stop-opacity=".1" />
            <stop offset=".13" stop-color="#fff" stop-opacity="0" />
            <stop offset=".87" stop-color="#fff" stop-opacity="0" />
            <stop offset=".955" stop-color="#151519" stop-opacity=".1" />
            <stop offset="1" stop-color="#151519" stop-opacity=".95" />
          </linearGradient>
          <linearGradient
            id="mb-foot-rubber"
            x1="0"
            y1="399.7"
            x2="0"
            y2="403"
            gradientUnits="userSpaceOnUse"
          >
            <stop stop-color="#19191b" />
            <stop offset=".6" stop-color="#3e3e40" />
            <stop offset="1" stop-color="#565657" />
          </linearGradient>
          <radialGradient id="mb-camera-lens">
            <stop stop-color="#252b30" />
            <stop offset=".45" stop-color="#111820" />
            <stop offset=".7" stop-color="#151819" />
            <stop offset="1" stop-color="#030404" />
          </radialGradient>
          <mask
            id="mb-screen-punch"
            maskUnits="userSpaceOnUse"
            x="0"
            y="95"
            width="500"
            height="310"
          >
            <rect x="0" y="95" width="500" height="310" fill="white" />
            <rect x="44.4" y="111" width="411.2" height="258.9" fill="black" />
          </mask>
          <clipPath id="mb-screen-clip">
            <path d="M52 103.15H448C452.75 103.15 455.6 106.1 455.6 111.15V369.9H44.4V111.15C44.4 106.1 47.25 103.15 52 103.15Z" />
          </clipPath>
          <clipPath id="mb-base-clip">
            <path d="M1.05 383H498.95V391.45C498.95 397.15 495.8 400.3 489.9 400.3H10.1C4.2 400.3 1.05 397.15 1.05 391.45V383Z" />
          </clipPath>
        </defs>
        <g mask="url(#mb-screen-punch)">
          <g id="mb-display-enclosure">
            <path
              d="M51.45 97.65H448.55C456.9 97.65 460.7 101.8 460.7 111.05V382.9H39.3V111.05C39.3 101.8 43.1 97.65 51.45 97.65Z"
              fill="url(#mb-lid-metal)"
              stroke="url(#mb-lid-edge)"
              stroke-width=".7"
            />
            <path
              d="M51.8 99.25H448.2C455.65 99.25 459.1 102.95 459.1 111.4V382.15H40.9V111.4C40.9 102.95 44.35 99.25 51.8 99.25Z"
              fill="url(#mb-glass-bezel)"
            />
            <path
              d="M40.15 381.4V112.3C40.15 103.85 43.05 99.05 50.85 98.65"
              stroke="#909292"
              stroke-opacity=".23"
              stroke-width=".55"
            />
            <path
              d="M459.85 380.9V111.7C459.85 103.6 456.85 99.1 449.15 98.65"
              stroke="#9a9b9b"
              stroke-opacity=".15"
              stroke-width=".55"
            />
            <path
              d="M51.5 98.55H448.5"
              stroke="#999a9a"
              stroke-opacity=".19"
              stroke-width=".45"
            />
          </g>
          <g id="mb-blank-screen" clip-path="url(#mb-screen-clip)">
            <path
              d="M44.4 103.15H455.6V369.9H44.4Z"
              fill="url(#mb-screen-black)"
            />
            <path
              d="M44.4 103.15H455.6V369.9H44.4Z"
              fill="url(#mb-screen-reflection)"
            />
          </g>
        </g>
        <path
          d="M44.4 111H455.6V369.9H44.4Z"
          fill="url(#mb-screen-reflection)"
        />
        <g id="mb-camera-notch">
          <path
            d="M228.35 102.55H271.65V108.7C271.65 110.25 270.9 111 269.35 111H230.65C229.1 111 228.35 110.25 228.35 108.7V102.55Z"
            fill="#020303"
          />
          <circle cx="250" cy="106.5" r="1.28" fill="#050607" />
          <circle cx="250" cy="106.5" r=".87" fill="url(#mb-camera-lens)" />
          <ellipse
            cx="249.79"
            cy="106.25"
            rx=".25"
            ry=".16"
            fill="#606771"
            opacity=".22"
          />
        </g>
        <g id="mb-display-chin">
          <path
            d="M41.65 369.9H458.35V382.55H41.65Z"
            fill="url(#mb-lower-bezel)"
          />
          <path
            d="M43.2 372.2H456.8"
            stroke="#3b3c3c"
            stroke-opacity=".2"
            stroke-width=".6"
          />
          <path
            d="M42.2 381.6H457.8"
            stroke="#393a3b"
            stroke-opacity=".38"
            stroke-width=".65"
          />
          <path d="M43 382.55H457" stroke="#000" stroke-width=".8" />
        </g>
        <g id="mb-rubber-feet">
          <path
            d="M23.2 399.6H54.65L52.8 401.5C52.2 402.2 51.1 402.65 49.3 402.65H28.55C26.95 402.65 25.7 402.2 25.15 401.5L23.2 399.6Z"
            fill="url(#mb-foot-rubber)"
          />
          <path
            d="M445.35 399.6H476.8L474.85 401.5C474.3 402.2 473.05 402.65 471.45 402.65H450.7C448.9 402.65 447.8 402.2 447.2 401.5L445.35 399.6Z"
            fill="url(#mb-foot-rubber)"
          />
        </g>
        <g id="mb-aluminum-base">
          <path
            d="M1.05 383H498.95V391.45C498.95 397.15 495.8 400.3 489.9 400.3H10.1C4.2 400.3 1.05 397.15 1.05 391.45V383Z"
            fill="url(#mb-base-metal)"
            stroke="#48484b"
            stroke-width=".5"
            stroke-linejoin="round"
          />
          <g clip-path="url(#mb-base-clip)">
            <path d="M0 382.5H500V401H0Z" fill="url(#mb-base-wide-light)" />
            <path d="M1.2 383H14V400.3H1.2Z" fill="url(#mb-left-metal-roll)" />
            <path
              d="M486 383H498.8V400.3H486Z"
              fill="url(#mb-right-metal-roll)"
            />
            <path
              d="M8.1 383.8V391.9C8.1 396.35 9.25 398.25 13.45 398.4H486.55C490.75 398.25 491.9 396.35 491.9 391.9V383.8"
              stroke="#111115"
              stroke-opacity=".3"
              stroke-width=".65"
            />
            <path
              d="M11.5 399.25H488.5"
              stroke="#8b8b8e"
              stroke-opacity=".3"
              stroke-width=".55"
            />
            <path
              d="M16 396.9H484"
              stroke="#222226"
              stroke-opacity=".28"
              stroke-width=".55"
            />
          </g>
          <path
            d="M2 383.1H498"
            stroke="url(#mb-lip-edge)"
            stroke-width=".65"
          />
          <g id="mb-finger-recess">
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
            <path
              d="M215 383.62H285"
              stroke="#b8b8bb"
              stroke-opacity=".5"
              stroke-width=".45"
            />
          </g>
        </g>
      </svg>
    </div>
  );
}
