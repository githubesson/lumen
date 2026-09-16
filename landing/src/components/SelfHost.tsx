import { For, type JSX } from "solid-js";
import { CopyButton } from "./CopyButton";
import { DOCS, REPO_URL } from "../lib/site";

const COMMANDS = [
  `git clone ${REPO_URL}.git && cd lumen`,
  "cp .env.example .env",
  "docker compose up -d --build",
];

const STEPS = [
  "Postgres, the Go API, the TIDAL proxy, and the web app start together from one Compose file.",
  "Ports bind to loopback. Put nginx in front with the site config from the repo and add TLS.",
  "The first run seeds an admin and prints a password. Everyone after that joins by invite.",
];

export function SelfHost(): JSX.Element {
  const script = COMMANDS.join("\n");
  return (
    <section id="self-host" class="section" aria-labelledby="self-host-heading">
      <div class="wrap grid grid-cols-1 items-start gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-16">
        <div class="flex flex-col gap-4">
          <p class="eyebrow">Self-host</p>
          <h2 id="self-host-heading" class="section-title">
            Up in three commands.
          </h2>
          <ul class="tick mt-2">
            <For each={STEPS}>{(step) => <li>{step}</li>}</For>
          </ul>
          <p class="body mt-2">
            Set at least <code class="mono text-fg">POSTGRES_PASSWORD</code> and{" "}
            <code class="mono text-fg">COVER_SIGN_KEY</code> in the env file.
            Every other knob is documented in{" "}
            <a
              href={DOCS.envExample}
              target="_blank"
              rel="noreferrer"
              class="link"
            >
              .env.example
            </a>
            .
          </p>
        </div>
        <div>
          <div class="code-frame">
            <div class="code-bar">
              <span class="eyebrow">Terminal</span>
              <CopyButton text={script} label="Copy the deployment commands" />
            </div>
            <pre class="code" tabindex="0" aria-label="Deployment commands">
              <For each={COMMANDS}>
                {(command, index) => (
                  <>
                    <span class="p">$ </span>
                    <span>{command}</span>
                    {index() < COMMANDS.length - 1 ? "\n" : ""}
                  </>
                )}
              </For>
            </pre>
          </div>
          <p class="body mt-4">
            Full walkthrough, reverse proxy, and backups in the{" "}
            <a href={DOCS.runIt} target="_blank" rel="noreferrer" class="link">
              README
            </a>
            .
          </p>
        </div>
      </div>
    </section>
  );
}
