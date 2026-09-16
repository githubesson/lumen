import { For, type JSX } from "solid-js";
import { Icon, type OutlineIconName } from "./Icons";
import { DOCS } from "../lib/site";

interface Client {
  icon: OutlineIconName;
  title: string;
  body: string;
  points: string[];
  link: { href: string; label: string };
}

const CLIENTS: Client[] = [
  {
    icon: "desktop",
    title: "Web and desktop",
    body: "Runs in any browser, or as a native window on Windows, macOS, and Linux.",
    points: [
      "Command palette search across tracks, albums, artists, and playlists",
      "Persistent player with queue, mini player, and lyrics panel",
      "Discord Rich Presence and automatic desktop updates",
      "Tweakable depth, radius, density, and light or dark theme",
    ],
    link: { href: DOCS.frontend, label: "Web and desktop client" },
  },
  {
    icon: "phone",
    title: "Mobile",
    body: "An Expo app for iOS and Android with the full library, playlists, uploads, and admin screens.",
    points: [
      "Background playback with lock-screen and now-playing controls",
      "AirPlay output picker, CarPlay, and Siri on iOS",
      "Remote control of any other device playing your library",
      "Instagram story sharing for Replay and tracks",
    ],
    link: { href: DOCS.mobile, label: "Mobile client, built with EAS" },
  },
  {
    icon: "server",
    title: "Server",
    body: "A Go API on Postgres that owns scanning, streaming, sharing, and accounts.",
    points: [
      "Multiple music roots with a filesystem watcher and manual rescan",
      "Cover art and metadata extraction, transcode cache for previews",
      "HMAC-signed public URLs for covers, shares, and embeds",
      "Docker images published to GHCR on every release",
    ],
    link: { href: DOCS.backend, label: "Backend" },
  },
];

export function Clients(): JSX.Element {
  return (
    <section id="clients" class="section" aria-labelledby="clients-heading">
      <div class="wrap">
        <div class="flex flex-col gap-4">
          <p class="eyebrow">Clients</p>
          <h2 id="clients-heading" class="section-title">
            One library. Every screen.
          </h2>
        </div>
        <div class="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <For each={CLIENTS}>
            {(client) => (
              <article class="card card-glow flex flex-col gap-5">
                <div class="flex items-center gap-3">
                  <div class="tile">
                    <Icon name={client.icon} size={18} />
                  </div>
                  <h3 class="card-title text-[17px]">{client.title}</h3>
                </div>
                <p class="body">{client.body}</p>
                <ul class="tick">
                  <For each={client.points}>{(point) => <li>{point}</li>}</For>
                </ul>
                <a
                  href={client.link.href}
                  target="_blank"
                  rel="noreferrer"
                  class="mt-auto inline-flex items-center gap-1.5 pt-2 text-sm font-medium text-fg no-underline hover:underline"
                >
                  {client.link.label}
                  <Icon name="arrowRight" size={14} />
                </a>
              </article>
            )}
          </For>
        </div>
        <p class="body mt-6">
          The mobile app is not on an app store. Self-hosters build it from
          source with EAS, pointed at their own server.
        </p>
      </div>
    </section>
  );
}
