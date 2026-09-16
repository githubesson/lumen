import type { JSX } from "solid-js";
import { Button } from "./Button";
import { Icon } from "./Icons";
import { Waveform } from "./Waveform";
import { detectPlatform, PLATFORM_LABEL } from "../lib/platform";
import { asset, REPO_URL } from "../lib/site";

export function Hero(): JSX.Element {
  const platform = detectPlatform();
  const downloadLabel =
    platform === "unknown"
      ? "Download the desktop app"
      : `Download for ${PLATFORM_LABEL[platform]}`;

  return (
    <section id="top" class="relative">
      <div class="wrap relative z-10 flex flex-col items-center pt-20 pb-8 text-center sm:pt-28 sm:pb-10">
        <p class="eyebrow enter" style={{ "--delay": "0ms" }}>
          Self-hosted · Invite-only · Open source
        </p>
        <h1
          class="display enter mt-5 max-w-[16ch]"
          style={{ "--delay": "80ms" }}
        >
          The music library you host yourself.
        </h1>
        <div
          class="enter mt-10 flex flex-wrap items-center justify-center gap-3"
          style={{ "--delay": "160ms" }}
        >
          <Button variant="primary" size="lg" href="#self-host">
            Deploy with Docker
          </Button>
          <Button
            size="lg"
            href="#downloads"
            leading={<Icon name="download" />}
          >
            {downloadLabel}
          </Button>
        </div>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          class="enter mt-6 inline-flex items-center gap-1.5 text-sm text-muted no-underline hover:text-fg"
          style={{ "--delay": "240ms" }}
        >
          View the source on GitHub
          <Icon name="arrowRight" size={14} />
        </a>
      </div>
      <div class="wrap relative z-10 pb-6 sm:pb-10">
        <Waveform class="enter" style={{ "--delay": "320ms" }} />
        <figure class="device enter m-0" style={{ "--delay": "380ms" }}>
          <picture>
            <source
              type="image/avif"
              srcset={`${asset("showcase-960.avif")} 960w, ${asset("showcase-1672.avif")} 1672w`}
              sizes="(max-width: 1120px) 100vw, 1072px"
            />
            <source
              type="image/webp"
              srcset={`${asset("showcase-960.webp")} 960w, ${asset("showcase-1672.webp")} 1672w`}
              sizes="(max-width: 1120px) 100vw, 1072px"
            />
            <img
              src={asset("showcase-1672.webp")}
              width="1672"
              height="941"
              alt="Lumen's desktop app on a laptop showing the Home screen with recently played albums and the player bar, beside the mobile app showing Good evening, Jump back in, and On repeat lists."
              loading="eager"
              fetchpriority="high"
              decoding="async"
            />
          </picture>
        </figure>
      </div>
    </section>
  );
}
