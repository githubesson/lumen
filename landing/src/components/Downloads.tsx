import {
  createMemo,
  createResource,
  For,
  Match,
  Show,
  Switch,
  type JSX,
} from "solid-js";
import { Button } from "./Button";
import { BrandIcon, Icon } from "./Icons";
import { detectPlatform, PLATFORM_LABEL, type Platform } from "../lib/platform";
import {
  fetchLatestRelease,
  formatDate,
  formatSize,
  type DownloadTarget,
} from "../lib/releases";
import { RELEASES_URL } from "../lib/site";

function PlatformGlyph(props: { platform: Platform }): JSX.Element {
  return (
    <Switch fallback={<Icon name="download" size={16} />}>
      <Match when={props.platform === "mac"}>
        <BrandIcon name="apple" />
      </Match>
      <Match when={props.platform === "windows"}>
        <BrandIcon name="windows" size={14} />
      </Match>
      <Match when={props.platform === "linux"}>
        <Icon name="terminal" size={16} />
      </Match>
    </Switch>
  );
}

function TargetButton(props: {
  target: DownloadTarget;
  primary?: boolean;
}): JSX.Element {
  return (
    <Button
      variant={props.primary ? "primary" : "secondary"}
      size="lg"
      href={props.target.url}
      leading={<PlatformGlyph platform={props.target.platform} />}
    >
      <span>
        {props.target.label} · {props.target.detail}
      </span>
      <span class="mono text-[12px] opacity-70">
        {formatSize(props.target.size)}
      </span>
    </Button>
  );
}

export function Downloads(): JSX.Element {
  const platform = detectPlatform();
  const [release] = createResource(fetchLatestRelease);

  // Reading an errored resource throws, so every branch goes through these
  // state-guarded accessors instead of calling release() directly.
  const info = () => (release.state === "ready" ? release() : undefined);
  const failed = () =>
    release.state === "errored" || (release.state === "ready" && !release());

  const lead = createMemo(() => {
    const current = info();
    if (!current) return undefined;
    return (
      current.targets.find((t) => t.platform === platform) ?? current.targets[0]
    );
  });
  const others = createMemo(() => {
    const current = info();
    const first = lead();
    if (!current) return [];
    return current.targets.filter((t) => t !== first);
  });

  const heading =
    platform === "unknown"
      ? "Download the desktop app."
      : `Download for ${PLATFORM_LABEL[platform]}.`;

  return (
    <section id="downloads" class="section" aria-labelledby="downloads-heading">
      <div class="wrap">
        <div class="card flex flex-col gap-8 p-7 sm:p-10">
          <div class="flex flex-col gap-4">
            <p class="eyebrow">Desktop app</p>
            <h2 id="downloads-heading" class="section-title">
              {heading}
            </h2>
          </div>

          <Switch>
            <Match when={release.loading}>
              <div
                class="flex flex-col gap-3"
                aria-busy="true"
                aria-live="polite"
              >
                <span class="sr-only">Looking up the latest release</span>
                <div class="skeleton h-4 w-56" />
                <div class="flex flex-wrap gap-3">
                  <div class="skeleton h-11 w-52 rounded-lg" />
                  <div class="skeleton h-11 w-44 rounded-lg" />
                  <div class="skeleton h-11 w-44 rounded-lg" />
                </div>
              </div>
            </Match>
            <Match when={failed()}>
              <div class="flex flex-col gap-4">
                <p class="body">
                  Unable to look up the latest build right now. Every release is
                  listed on GitHub.
                </p>
                <div>
                  <Button
                    variant="primary"
                    size="lg"
                    href={RELEASES_URL}
                    external
                    leading={<Icon name="external" size={16} />}
                  >
                    Open releases on GitHub
                  </Button>
                </div>
              </div>
            </Match>
            <Match when={info()}>
              {(current) => (
                <div class="flex flex-col gap-5">
                  <p class="mono flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-subtle">
                    <span class="text-fg">Lumen {current().version}</span>
                    <Show when={current().prerelease}>
                      <span class="rounded-sm border border-line px-1.5 py-0.5 text-[10px] tracking-[0.08em] uppercase">
                        Pre-release
                      </span>
                    </Show>
                    <span>Published {formatDate(current().publishedAt)}</span>
                  </p>
                  <div class="flex flex-wrap gap-3">
                    <Show when={lead()}>
                      {(target) => <TargetButton target={target()} primary />}
                    </Show>
                    <For each={others()}>
                      {(target) => <TargetButton target={target} />}
                    </For>
                  </div>
                  <p class="body max-w-[64ch]">
                    Builds are unsigned. Windows SmartScreen and macOS
                    Gatekeeper will ask you to confirm before the first launch.
                    Release notes and older versions are on the{" "}
                    <a
                      href={current().url}
                      target="_blank"
                      rel="noreferrer"
                      class="link"
                    >
                      release page
                    </a>
                    .
                  </p>
                </div>
              )}
            </Match>
          </Switch>
        </div>
      </div>
    </section>
  );
}
