import { Show, type JSX } from "solid-js";

// A jagged waveform in the spirit of the app icon, morphing between three
// randomised shapes with SMIL so the browser animates it off the main
// thread. Points stay in fixed order, which is what makes the morph smooth.
const WIDTH = 1200;
const HEIGHT = 120;
const COUNT = 56;

function noise(i: number, seed: number): number {
  const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function frame(seed: number): string {
  const pts: string[] = [];
  for (let i = 0; i < COUNT; i++) {
    const t = i / (COUNT - 1);
    const envelope = Math.pow(Math.sin(Math.PI * t), 0.8);
    const amplitude =
      (0.12 + 0.88 * noise(i, seed)) * envelope * (HEIGHT / 2 - 6);
    const direction = i % 2 === 0 ? -1 : 1;
    pts.push(
      `${(t * WIDTH).toFixed(1)},${(HEIGHT / 2 + direction * amplitude).toFixed(1)}`,
    );
  }
  return pts.join(" ");
}

const FRAMES = [frame(1), frame(2), frame(3)];
const VALUES = [...FRAMES, FRAMES[0]].join(";");

function Ribbon(props: {
  animate: boolean;
  class: string;
  width: number;
}): JSX.Element {
  return (
    <svg
      class={props.class}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        points={FRAMES[0]}
        fill="none"
        stroke="url(#wave-grad)"
        stroke-width={props.width}
        stroke-linejoin="round"
        stroke-linecap="round"
        vector-effect="non-scaling-stroke"
      >
        <Show when={props.animate}>
          <animate
            attributeName="points"
            values={VALUES}
            dur="14s"
            repeatCount="indefinite"
            calcMode="spline"
            keyTimes="0;0.34;0.67;1"
            keySplines="0.45 0 0.55 1;0.45 0 0.55 1;0.45 0 0.55 1"
          />
        </Show>
      </polyline>
    </svg>
  );
}

export function Waveform(props: {
  class?: string;
  style?: JSX.CSSProperties;
}): JSX.Element {
  const animate = !window.matchMedia("(prefers-reduced-motion: reduce)")
    .matches;
  return (
    <div
      class={`wave-band ${props.class ?? ""}`}
      style={props.style}
      aria-hidden="true"
    >
      <svg
        width="0"
        height="0"
        aria-hidden="true"
        style={{ position: "absolute" }}
      >
        <defs>
          <linearGradient id="wave-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" style={{ "stop-color": "var(--glow-a)" }} />
            <stop offset="0.38" style={{ "stop-color": "var(--glow-b)" }} />
            <stop offset="0.7" style={{ "stop-color": "var(--glow-c)" }} />
            <stop offset="1" style={{ "stop-color": "var(--glow-d)" }} />
          </linearGradient>
        </defs>
      </svg>
      <Ribbon animate={animate} class="wave wave-glow" width={5} />
      <Ribbon animate={animate} class="wave" width={1.5} />
    </div>
  );
}
