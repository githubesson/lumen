import { onCleanup, onMount, type JSX } from "solid-js";
import { Iphone } from "./Iphone";
import { Equalizer, LiveSignal } from "./LiveIcons";
import { Macbook } from "./Macbook";
import { Waveform } from "./Waveform";
import { asset } from "../lib/site";
import { theme } from "../lib/theme";

// The product showcase: a MacBook Pro and an iPhone frame around real app
// screenshots, one set per theme so the devices match the page. The waveform
// runs behind them like a horizon and two decorative chips float over the
// scene. Below the fold the devices sit lower with the ribbon and chips
// faded; they rise and the rest comes in as they scroll up, driven by a
// single --tilt custom property.

const SCREENS = {
  desktop: { widths: [1280, 800], width: 1280, height: 820 },
  mobile: { widths: [780, 480], width: 1320, height: 2868 },
} as const;

function Screen(props: {
  kind: keyof typeof SCREENS;
  sizes: string;
  alt: string;
}): JSX.Element {
  const spec = () => SCREENS[props.kind];
  const srcset = (format: string) =>
    spec().widths
      .map((w) => `${asset(`${props.kind}-${theme()}-${w}.${format}`)} ${w}w`)
      .join(", ");
  return (
    <picture>
      <source type="image/avif" srcset={srcset("avif")} sizes={props.sizes} />
      <source type="image/webp" srcset={srcset("webp")} sizes={props.sizes} />
      <img
        src={asset(`${props.kind}-${theme()}-${spec().widths[0]}.webp`)}
        width={spec().width}
        height={spec().height}
        alt={props.alt}
        loading="eager"
        fetchpriority={props.kind === "desktop" ? "high" : "auto"}
        decoding="async"
      />
    </picture>
  );
}

export function Stage(): JSX.Element {
  let stage!: HTMLDivElement;

  onMount(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = stage.getBoundingClientRect().top;
      const vh = window.innerHeight;
      const tilt = (top - vh * 0.2) / (vh * 0.55);
      stage.style.setProperty(
        "--tilt",
        Math.min(1, Math.max(0, tilt)).toFixed(3),
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    });
  });

  return (
    <div ref={stage} class="stage enter" style={{ "--delay": "320ms" }}>
      <Waveform class="stage-wave" />
      <div class="stage-scene">
        <Macbook class="laptop">
          <Screen
            kind="desktop"
            sizes="(max-width: 1120px) 74vw, 830px"
            alt="Lumen's desktop app on the Home screen: a welcome banner for the album FF by Młody West with Play and Browse library buttons, a Recently played row of albums, and the player bar playing Warszawski sen."
          />
        </Macbook>
        <Iphone class="phone">
          <Screen
            kind="mobile"
            sizes="(max-width: 1120px) 20vw, 215px"
            alt="Lumen's mobile app on the Home screen: Good evening, a Jump back in card for Warszawski sen, a row of albums, the On repeat list, and a mini player."
          />
        </Iphone>
      </div>
      <div class="stage-chip stage-chip-playing" aria-hidden="true">
        <span class="tile">
          <Equalizer />
        </span>
        <span class="stage-chip-text">
          <span class="stage-chip-label">Now playing</span>
          <span class="stage-chip-value">Warszawski sen · Młody West</span>
        </span>
      </div>
      <div class="stage-chip stage-chip-remote" aria-hidden="true">
        <span class="tile">
          <LiveSignal size={16} />
        </span>
        <span class="stage-chip-text">
          <span class="stage-chip-label">Remote</span>
          <span class="stage-chip-value">Phone in control</span>
        </span>
      </div>
    </div>
  );
}
