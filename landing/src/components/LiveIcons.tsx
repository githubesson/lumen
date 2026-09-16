import type { JSX } from "solid-js";

// Ambient versions of two Heroicons, split into parts so each can animate.
// Both are decorative: the card title carries the meaning.

const ARCS = [
  "M8.288 15.038a5.25 5.25 0 017.424 0",
  "M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0",
  "M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0",
];
const DOT = "M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z";

export function LiveSignal(props: { size?: number }): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={props.size ?? 18}
      height={props.size ?? 18}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={DOT} />
      <path
        d={ARCS[0]}
        class="signal-arc"
        style={{ "animation-delay": "0ms" }}
      />
      <path
        d={ARCS[1]}
        class="signal-arc"
        style={{ "animation-delay": "320ms" }}
      />
      <path
        d={ARCS[2]}
        class="signal-arc"
        style={{ "animation-delay": "640ms" }}
      />
    </svg>
  );
}

const SPARKS = [
  "M9.813 15.904L9.093 18.4a.75.75 0 01-1.436 0l-.72-2.496a4.5 4.5 0 00-3.14-3.14L1.3 12.043a.75.75 0 010-1.436l2.496-.72a4.5 4.5 0 003.14-3.14l.72-2.496a.75.75 0 011.436 0l.72 2.496a4.5 4.5 0 003.14 3.14l2.496.72a.75.75 0 010 1.436l-2.496.72a4.5 4.5 0 00-3.14 3.14z",
  "M18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z",
  "M16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z",
];

export function LiveSparkles(props: { size?: number }): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={props.size ?? 18}
      height={props.size ?? 18}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path
        d={SPARKS[0]}
        class="sparkle"
        style={{ "animation-delay": "0ms" }}
      />
      <path
        d={SPARKS[1]}
        class="sparkle"
        style={{ "animation-delay": "900ms" }}
      />
      <path
        d={SPARKS[2]}
        class="sparkle"
        style={{ "animation-delay": "1600ms" }}
      />
    </svg>
  );
}

// Three bars bouncing out of phase; styled by the .eq rules in index.css.
export function Equalizer(): JSX.Element {
  return (
    <span class="eq" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export const LiveIcons = {
  signal: LiveSignal,
  sparkles: LiveSparkles,
} as const;
