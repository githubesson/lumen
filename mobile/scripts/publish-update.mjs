import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Publish an OTA update.
 *
 * Usage: npm run update:ota -- <branch> ["message"]
 *
 * Wraps `eas update` with the three things a local publish needs and that are
 * easy to get wrong by hand:
 *
 * 1. `--platform ios`. iOS is the only shipped target. Left at the default
 *    (`all`), the export also runs the web pass, and `web.output: "static"`
 *    makes that prerender the routes in Node — where any screen reaching a
 *    native module dies with "Cannot read properties of undefined (reading
 *    'getEnforcing')". Android is likewise not shipped, so bundling it is
 *    wasted time.
 *
 * 2. `CI=1`. metro.config.js resolves @music-library/core straight to the
 *    sibling ../core during development so edits hot-reload, but Metro cannot
 *    hash files outside the project root during an export ("Failed to get the
 *    SHA-1"). The config switches to the vendored copy when CI or EAS_BUILD is
 *    set, which is also what the Expo CLI asks for in non-interactive runs.
 *
 * 3. `sync:core` first, because that vendored copy is what actually gets
 *    bundled — publishing without refreshing it silently ships stale core.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

/** EAS environments, which this project's update branches are named after. */
const ENVIRONMENTS = ["development", "preview", "production"];

const [branch, ...rest] = process.argv.slice(2);

if (!branch) {
  console.error("usage: npm run update:ota -- <branch> [\"message\"]");
  console.error(`  branch is typically one of: ${ENVIRONMENTS.join(", ")}`);
  // Deliberately no default: publishing to the wrong branch is not recoverable
  // by re-running, it just adds another update to a channel real installs read.
  process.exit(1);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: projectRoot,
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options,
    env: { ...process.env, ...options.env },
  });
}

function lastCommitSubject() {
  try {
    return run("git", ["log", "-1", "--pretty=%s"], { capture: true }).trim();
  } catch {
    return "";
  }
}

const message = rest.join(" ").trim() || lastCommitSubject() || "update";
const environment = ENVIRONMENTS.includes(branch) ? branch : "production";

run("node", [path.join(projectRoot, "scripts", "sync-core-package.mjs")]);

run(
  "npx",
  [
    "eas-cli",
    "update",
    "--branch",
    branch,
    "--environment",
    environment,
    "--platform",
    "ios",
    "--message",
    message,
  ],
  { env: { CI: "1" } },
);
