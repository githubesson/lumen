import {
  For,
  Show,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { Icon, type OutlineIconName } from "./Icons";
import { LiveIcons } from "./LiveIcons";
import "../styles/features.css";

const EXTRAS: { icon: OutlineIconName; title: string; body: string }[] = [
  {
    icon: "link",
    title: "Made to share",
    body: "Send a link with cover art, a title, and a playable preview in Discord. Signed links open without a login.",
  },
  {
    icon: "lock",
    title: "Your people, invited",
    body: "Invite-only accounts with roles, use limits, and expiry dates. Protected by Argon2id passwords and HTTP-only sessions.",
  },
  {
    icon: "note",
    title: "More than listening",
    body: "Follow along with lyrics, scrobble to Last.fm, and show what’s playing with Discord Rich Presence on desktop.",
  },
  {
    icon: "upload",
    title: "Room for more",
    body: "Upload from web or mobile, edit metadata, schedule imports from external sources, or connect TIDAL passthrough.",
  },
];

const reducedMotion = (): boolean =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Every illustration below is decorative and aria-hidden: the copy carries
// the meaning, and the hover play is a demo of the feature, not the feature.

/** A pointer-following spotlight and lift, shared by the four big cards. */
function useSpotlight(): {
  onPointerMove: (event: PointerEvent) => void;
} {
  return {
    onPointerMove(event) {
      const card = event.currentTarget as HTMLElement;
      const rect = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${event.clientX - rect.left}px`);
      card.style.setProperty("--my", `${event.clientY - rect.top}px`);
    },
  };
}

const liveIcon = (name: OutlineIconName) =>
  name in LiveIcons ? LiveIcons[name as keyof typeof LiveIcons] : undefined;

function FeatureHeading(props: {
  icon: OutlineIconName;
  label: string;
}): JSX.Element {
  return (
    <div class="feature-kicker">
      <Show
        when={liveIcon(props.icon)}
        fallback={<Icon name={props.icon} size={16} />}
      >
        {(live) => <Dynamic component={live()} size={16} />}
      </Show>
      <span>{props.label}</span>
    </div>
  );
}

const BAR_COUNT = 56;
const BAR_HEIGHTS = Array.from(
  { length: BAR_COUNT },
  (_, i) => 16 + Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.31)) * 64,
);
const TRACK_SECONDS = 260;

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function Bars(): JSX.Element {
  return (
    <For each={BAR_HEIGHTS}>
      {(height, index) => (
        <span style={{ "--i": String(index()), height: `${height}%` }} />
      )}
    </For>
  );
}

function StreamCard(): JSX.Element {
  const [progress, setProgress] = createSignal(0.59);
  const [scrubbing, setScrubbing] = createSignal(false);
  const spotlight = useSpotlight();
  let wave!: HTMLDivElement;

  // The demo track plays while the card is on screen and the pointer is
  // elsewhere; scrubbing takes over and playback resumes from the new spot.
  onMount(() => {
    if (reducedMotion()) return;
    let frame = 0;
    let last = 0;
    let visible = false;
    const tick = (now: number) => {
      if (!visible) return;
      if (last && !scrubbing()) {
        const next = progress() + (now - last) / 1000 / TRACK_SECONDS;
        setProgress(next >= 0.985 ? 0.02 : next);
      }
      last = now;
      frame = requestAnimationFrame(tick);
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      cancelAnimationFrame(frame);
      last = 0;
      if (visible) frame = requestAnimationFrame(tick);
    });
    observer.observe(wave);
    onCleanup(() => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    });
  });

  const scrubTo = (event: PointerEvent) => {
    const rect = wave.getBoundingClientRect();
    const fraction = (event.clientX - rect.left) / rect.width;
    setProgress(Math.min(0.995, Math.max(0.005, fraction)));
  };

  return (
    <li
      class="card feature-card feature-stream"
      classList={{ "is-scrubbing": scrubbing() }}
      onPointerMove={spotlight.onPointerMove}
    >
      <span class="feature-spot" aria-hidden="true" />
      <FeatureHeading icon="bolt" label="Instant playback" />
      <div class="feature-copy">
        <h3>Skip to the good part.</h3>
        <p class="body">
          Press play. Jump ahead. Range-request streaming lets you scrub
          anywhere without waiting for the whole file.
        </p>
      </div>
      <div class="stream-preview" aria-hidden="true">
        <div class="preview-meta">
          <span class="stream-state">
            <span class="stream-dot" />
            {scrubbing() ? "SEEKING" : "NOW PLAYING"}
          </span>
          <span>SEEK ANYWHERE</span>
        </div>
        <div
          ref={wave}
          class="feature-wave"
          style={{
            "--progress": String(progress()),
            "--head": String(progress() * BAR_COUNT - 0.5),
          }}
          onPointerEnter={(event) => {
            setScrubbing(true);
            scrubTo(event);
          }}
          onPointerMove={scrubTo}
          onPointerDown={scrubTo}
          onPointerLeave={() => setScrubbing(false)}
        >
          <div class="wave-layer">
            <Bars />
          </div>
          <div class="wave-layer wave-played">
            <Bars />
          </div>
          <div class="feature-playhead" />
        </div>
        <div class="preview-meta">
          <span class="stream-time">{clock(progress() * TRACK_SECONDS)}</span>
          <span class="stream-caption">
            {scrubbing()
              ? "Drops you right there."
              : "Right where you want to be."}
          </span>
          <span>{clock(TRACK_SECONDS)}</span>
        </div>
      </div>
    </li>
  );
}

function ReplayCard(): JSX.Element {
  const spotlight = useSpotlight();
  let card!: HTMLLIElement;

  // Pointer position from -0.5 to 0.5 on each axis; CSS turns it into a
  // perspective tilt for the card and a little parallax for the art.
  const tilt = (event: PointerEvent) => {
    spotlight.onPointerMove(event);
    const rect = card.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    card.style.setProperty("--px", x.toFixed(3));
    card.style.setProperty("--py", y.toFixed(3));
  };
  const rest = () => {
    card.style.setProperty("--px", "0");
    card.style.setProperty("--py", "0");
  };

  return (
    <li
      ref={card}
      class="card feature-card feature-replay"
      onPointerMove={tilt}
      onPointerLeave={rest}
    >
      <span class="feature-spot" aria-hidden="true" />
      <FeatureHeading icon="sparkles" label="Yearly Replay" />
      <div class="replay-art" aria-hidden="true">
        <div class="replay-platter">
          <div class="replay-disc">
            <div class="replay-disc-label">
              <Icon name="note" size={26} />
            </div>
          </div>
          <span class="replay-shine" />
          <div class="replay-arm">
            <span class="replay-arm-pivot" />
            <span class="replay-arm-head" />
          </div>
        </div>
        <span class="replay-stamp">
          YOUR YEAR
          <br />
          ON REPEAT.
        </span>
      </div>
      <div class="feature-copy">
        <h3>A year that sounds like you.</h3>
        <p class="body">
          Your top songs, listening stats, and activity, wrapped up in a recap
          you can share.
        </p>
      </div>
    </li>
  );
}

const PLAYLISTS: { name: string; icon: OutlineIconName }[] = [
  { name: "Heavy rotation", icon: "note" },
  { name: "After hours", icon: "moon" },
  { name: "The long way home", icon: "signal" },
];

function Equalizer(): JSX.Element {
  return (
    <span class="eq" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function LibraryCard(): JSX.Element {
  const [active, setActive] = createSignal(0);
  const [hovered, setHovered] = createSignal(false);
  const spotlight = useSpotlight();

  // The playing row wanders on its own; hovering picks one and holds it.
  onMount(() => {
    if (reducedMotion()) return;
    const timer = setInterval(() => {
      if (!hovered()) setActive((i) => (i + 1) % PLAYLISTS.length);
    }, 2800);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <li
      class="card feature-card feature-library"
      onPointerMove={spotlight.onPointerMove}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <span class="feature-spot" aria-hidden="true" />
      <FeatureHeading icon="queue" label="Your collection" />
      <div class="library-preview" aria-hidden="true">
        <For each={PLAYLISTS}>
          {(playlist, index) => (
            <div
              class="library-row"
              classList={{ "is-active": active() === index() }}
              onPointerEnter={() => setActive(index())}
            >
              <span class={`playlist-art playlist-art-${index()}`}>
                <Icon name={playlist.icon} size={20} />
              </span>
              <span class="library-row-name">{playlist.name}</span>
              <span class="library-row-meta">
                <Equalizer />
                <span class="library-row-number">0{index() + 1}</span>
              </span>
            </div>
          )}
        </For>
      </div>
      <div class="feature-copy">
        <h3>Keep your favorites close.</h3>
        <p class="body">
          Make playlists together, favorite tracks, and revisit your listening
          history on any device.
        </p>
      </div>
    </li>
  );
}

type Device = "desktop" | "phone";

function SyncCard(): JSX.Element {
  // The device under the pointer takes the remote; the other keeps playing.
  const [controller, setController] = createSignal<Device>("phone");
  const [handoffs, setHandoffs] = createSignal(0);
  const spotlight = useSpotlight();
  const playing = () => (controller() === "phone" ? "desktop" : "phone");
  const takeControl = (name: Device) => {
    if (controller() === name) return;
    setController(name);
    setHandoffs((n) => n + 1);
  };

  const device = (name: Device, icon: OutlineIconName, label: string) => (
    <div
      class="sync-device"
      classList={{
        "is-playing": playing() === name,
        "is-controlling": controller() === name,
      }}
      onPointerEnter={() => takeControl(name)}
      onClick={() => takeControl(name)}
    >
      <span class="sync-device-screen">
        <Icon name={icon} size={name === "desktop" ? 30 : 28} />
        <Equalizer />
      </span>
      <span>{label}</span>
      <small class="sync-role">
        <span class="sync-role-playing">Playing here</span>
        <span class="sync-role-control">In control</span>
      </small>
    </div>
  );

  return (
    <li
      class="card feature-card feature-sync"
      classList={{ "flow-left": controller() === "phone" }}
      onPointerMove={spotlight.onPointerMove}
    >
      <span class="feature-spot" aria-hidden="true" />
      <FeatureHeading icon="signal" label="Connected listening" />
      <div class="feature-copy">
        <h3>
          Two devices.
          <br />
          One uninterrupted vibe.
        </h3>
        <p class="body">
          Start on your desktop. Steer from your phone. Playback, queue,
          shuffle, and repeat stay in sync, live.
        </p>
      </div>
      <div class="sync-preview" aria-hidden="true">
        {device("desktop", "desktop", "Desktop")}
        <div class="sync-connection">
          <span class="sync-line" />
          <span class="sync-hub">
            <LiveIcons.signal size={20} />
            <Show when={handoffs()} keyed>
              <span class="sync-ping" />
            </Show>
          </span>
          <span class="sync-line" />
        </div>
        {device("phone", "phone", "Phone")}
      </div>
    </li>
  );
}

export function Features(): JSX.Element {
  let grid!: HTMLUListElement;
  const [revealed, setRevealed] = createSignal(false);

  // Cards rise into place the first time the grid scrolls into view.
  onMount(() => {
    if (reducedMotion() || !("IntersectionObserver" in window)) {
      setRevealed(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setRevealed(true);
        observer.disconnect();
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    observer.observe(grid);
    onCleanup(() => observer.disconnect());
  });

  return (
    <section id="features" class="section" aria-labelledby="features-heading">
      <div class="wrap">
        <div class="flex flex-col gap-4">
          <p class="eyebrow">Features</p>
          <h2 id="features-heading" class="section-title">
            Everything a music library needs.
          </h2>
        </div>
        <ul
          ref={grid}
          class="feature-grid"
          classList={{ "is-revealed": revealed() }}
        >
          <StreamCard />
          <ReplayCard />
          <LibraryCard />
          <SyncCard />
          <For each={EXTRAS}>
            {(feature) => (
              <li class="feature-extra">
                <div class="tile">
                  <Icon name={feature.icon} size={18} />
                </div>
                <h3 class="card-title">{feature.title}</h3>
                <p class="body">{feature.body}</p>
              </li>
            )}
          </For>
        </ul>
      </div>
    </section>
  );
}
