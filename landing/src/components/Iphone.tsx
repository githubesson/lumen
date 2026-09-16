import { createUniqueId, Show, type JSX } from "solid-js";

// The Magic UI iPhone mockup (https://magicui.design/docs/components/iphone),
// ported from React to Solid. The frame is an SVG; the screen is a DOM
// overlay positioned by percentages of the frame, so an <img>, <picture>, or
// <video> can be dropped in as children. Sizing comes from the wrapper's
// width; the aspect ratio is fixed at 433:882.

const PHONE_WIDTH = 433;
const PHONE_HEIGHT = 882;
const SCREEN_X = 21.25;
const SCREEN_Y = 19.25;
const SCREEN_WIDTH = 389.5;
const SCREEN_HEIGHT = 843.5;
const SCREEN_RADIUS = 55.75;

const pct = (part: number, whole: number) => `${(part / whole) * 100}%`;
const SCREEN_STYLE: JSX.CSSProperties = {
  left: pct(SCREEN_X, PHONE_WIDTH),
  top: pct(SCREEN_Y, PHONE_HEIGHT),
  width: pct(SCREEN_WIDTH, PHONE_WIDTH),
  height: pct(SCREEN_HEIGHT, PHONE_HEIGHT),
  "border-radius": `${pct(SCREEN_RADIUS, SCREEN_WIDTH)} / ${pct(SCREEN_RADIUS, SCREEN_HEIGHT)}`,
};

const SCREEN_PATH = `M${SCREEN_X} 75C${SCREEN_X} 44.2101 46.2101 ${SCREEN_Y} 77 ${SCREEN_Y}H355C385.79 ${SCREEN_Y} 410.75 44.2101 410.75 75V807C410.75 837.79 385.79 862.75 355 862.75H77C46.2101 862.75 ${SCREEN_X} 837.79 ${SCREEN_X} 807V75Z`;

export function Iphone(props: {
  class?: string;
  style?: JSX.CSSProperties;
  /** Screen image, when no children are given. */
  src?: string;
  /** Screen content: an <img>, <picture>, or <video> filling the screen. */
  children?: JSX.Element;
}): JSX.Element {
  const id = createUniqueId();
  const punch = `iphone-punch-${id}`;
  const hasMedia = () => props.children !== undefined || !!props.src;
  return (
    <div
      class={`iphone ${props.class ?? ""}`}
      style={{
        "aspect-ratio": `${PHONE_WIDTH} / ${PHONE_HEIGHT}`,
        ...props.style,
      }}
    >
      <Show when={hasMedia()}>
        <div class="iphone-screen" style={SCREEN_STYLE}>
          <Show when={props.children} fallback={<img src={props.src} alt="" />}>
            {props.children}
          </Show>
        </div>
      </Show>
      <svg
        viewBox={`0 0 ${PHONE_WIDTH} ${PHONE_HEIGHT}`}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        class="iphone-svg"
        aria-hidden="true"
      >
        <g mask={hasMedia() ? `url(#${punch})` : undefined}>
          <path
            d="M2 73C2 32.6832 34.6832 0 75 0H357C397.317 0 430 32.6832 430 73V809C430 849.317 397.317 882 357 882H75C34.6832 882 2 849.317 2 809V73Z"
            class="iphone-frame"
          />
          <path
            d="M0 171C0 170.448 0.447715 170 1 170H3V204H1C0.447715 204 0 203.552 0 203V171Z"
            class="iphone-frame"
          />
          <path
            d="M1 234C1 233.448 1.44772 233 2 233H3.5V300H2C1.44772 300 1 299.552 1 299V234Z"
            class="iphone-frame"
          />
          <path
            d="M1 319C1 318.448 1.44772 318 2 318H3.5V385H2C1.44772 385 1 384.552 1 384V319Z"
            class="iphone-frame"
          />
          <path
            d="M430 279H432C432.552 279 433 279.448 433 280V384C433 384.552 432.552 385 432 385H430V279Z"
            class="iphone-frame"
          />
          <path
            d="M6 74C6 35.3401 37.3401 4 76 4H356C394.66 4 426 35.3401 426 74V808C426 846.66 394.66 878 356 878H76C37.3401 878 6 846.66 6 808V74Z"
            class="iphone-body"
          />
        </g>
        <path
          opacity="0.5"
          d="M174 5H258V5.5C258 6.60457 257.105 7.5 256 7.5H176C174.895 7.5 174 6.60457 174 5.5V5Z"
          class="iphone-frame"
        />
        <path
          d={SCREEN_PATH}
          class="iphone-frame iphone-bezel"
          mask={hasMedia() ? `url(#${punch})` : undefined}
        />
        <path
          d="M154 48.5C154 38.2827 162.283 30 172.5 30H259.5C269.717 30 278 38.2827 278 48.5C278 58.7173 269.717 67 259.5 67H172.5C162.283 67 154 58.7173 154 48.5Z"
          class="iphone-island"
        />
        <path
          d="M249 48.5C249 42.701 253.701 38 259.5 38C265.299 38 270 42.701 270 48.5C270 54.299 265.299 59 259.5 59C253.701 59 249 54.299 249 48.5Z"
          class="iphone-cam-ring"
        />
        <path
          d="M254 48.5C254 45.4624 256.462 43 259.5 43C262.538 43 265 45.4624 265 48.5C265 51.5376 262.538 54 259.5 54C256.462 54 254 51.5376 254 48.5Z"
          class="iphone-cam-lens"
        />
        <defs>
          <mask
            id={punch}
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={PHONE_WIDTH}
            height={PHONE_HEIGHT}
          >
            <rect
              x="0"
              y="0"
              width={PHONE_WIDTH}
              height={PHONE_HEIGHT}
              fill="white"
            />
            <rect
              x={SCREEN_X}
              y={SCREEN_Y}
              width={SCREEN_WIDTH}
              height={SCREEN_HEIGHT}
              rx={SCREEN_RADIUS}
              ry={SCREEN_RADIUS}
              fill="black"
            />
          </mask>
        </defs>
      </svg>
    </div>
  );
}
