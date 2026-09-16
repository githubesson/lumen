import { For, type JSX } from "solid-js";

const PLATFORMS = [
  "Web",
  "Windows",
  "macOS",
  "Linux",
  "iOS",
  "Android",
  "Docker",
];

export function Platforms(): JSX.Element {
  return (
    <section
      class="wrap flex flex-col items-center gap-4 py-10 sm:py-12"
      aria-labelledby="platforms-heading"
    >
      <h2 id="platforms-heading" class="eyebrow">
        Runs on
      </h2>
      <ul class="m-0 flex list-none flex-wrap justify-center gap-2 p-0">
        <For each={PLATFORMS}>{(name) => <li class="chip">{name}</li>}</For>
      </ul>
    </section>
  );
}
