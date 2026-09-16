import { For, type JSX } from "solid-js";
import { Icon, type OutlineIconName } from "./Icons";
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

// Static illustrations, not interactive player controls or user data.
function WaveBars(): JSX.Element {
  return (
    <div class="feature-wave">
      <For
        each={Array.from(
          { length: 56 },
          (_, i) => 16 + Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.31)) * 64,
        )}
      >
        {(height, index) => (
          <span
            classList={{ "is-played": index() < 33 }}
            style={{ height: `${height}%` }}
          />
        )}
      </For>
      <div class="feature-playhead" />
    </div>
  );
}

function FeatureHeading(props: {
  icon: OutlineIconName;
  label: string;
}): JSX.Element {
  return (
    <div class="feature-kicker">
      <Icon name={props.icon} size={16} />
      <span>{props.label}</span>
    </div>
  );
}

export function Features(): JSX.Element {
  return (
    <section id="features" class="section" aria-labelledby="features-heading">
      <div class="wrap">
        <div class="flex flex-col gap-4">
          <p class="eyebrow">Features</p>
          <h2 id="features-heading" class="section-title">
            Everything a music library needs.
          </h2>
        </div>
        <ul class="feature-grid">
          <li class="card feature-card feature-stream">
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
                <span>NOW PLAYING</span>
                <span>SEEK ANYWHERE</span>
              </div>
              <WaveBars />
              <div class="preview-meta">
                <span>2:34</span>
                <span class="stream-caption">Right where you want to be.</span>
                <span>4:20</span>
              </div>
            </div>
          </li>
          <li class="card feature-card feature-replay">
            <FeatureHeading icon="sparkles" label="Yearly Replay" />
            <div class="replay-art" aria-hidden="true">
              <div class="replay-disc">
                <div class="replay-disc-label">
                  <Icon name="note" size={26} />
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
                Your top songs, listening stats, and activity, wrapped up in a
                recap you can share.
              </p>
            </div>
          </li>
          <li class="card feature-card feature-library">
            <FeatureHeading icon="queue" label="Your collection" />
            <div class="library-preview" aria-hidden="true">
              <For
                each={["Heavy rotation", "After hours", "The long way home"]}
              >
                {(name, index) => (
                  <div class="library-row">
                    <span class={`playlist-art playlist-art-${index()}`}>
                      <Icon
                        name={
                          index() === 0
                            ? "note"
                            : index() === 1
                              ? "moon"
                              : "signal"
                        }
                        size={20}
                      />
                    </span>
                    <span>{name}</span>
                    <span class="library-row-number">0{index() + 1}</span>
                  </div>
                )}
              </For>
            </div>
            <div class="feature-copy">
              <h3>Keep your favorites close.</h3>
              <p class="body">
                Make playlists together, favorite tracks, and revisit your
                listening history on any device.
              </p>
            </div>
          </li>
          <li class="card feature-card feature-sync">
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
              <div class="sync-device">
                <Icon name="desktop" size={30} />
                <span>Desktop</span>
                <small>Playing here</small>
              </div>
              <div class="sync-connection">
                <span />
                <Icon name="signal" size={20} />
                <span />
              </div>
              <div class="sync-device">
                <Icon name="phone" size={28} />
                <span>Phone</span>
                <small>In control</small>
              </div>
            </div>
          </li>
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
