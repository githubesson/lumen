// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";

it("backs off failed Discord connections and destroys each failed client", async () => {
  const compiled = ts.transpileModule(readFileSync(new URL("../electron/discord-presence.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  let now = 0;
  const login = vi.fn().mockRejectedValue(new Error("Discord is not running"));
  const destroy = vi.fn().mockResolvedValue(undefined);
  const exports = {} as typeof import("../electron/discord-presence");
  runInNewContext(compiled, {
    exports, Date: { now: () => now }, console: { log() {}, warn() {} },
    require: () => ({ Client: class { on() {} login = login; destroy = destroy; } }),
  });
  exports.configureDiscordPresence({ clientId: "fixture" });
  for (let push = 0; push < 5; push++) await exports.pushDiscordActivity({ title: "Song", isPlaying: true });
  expect(login).toHaveBeenCalledTimes(1);
  expect(destroy).toHaveBeenCalledTimes(1);
  now = 30_000;
  await exports.pushDiscordActivity({ title: "Song", isPlaying: true });
  expect(login).toHaveBeenCalledTimes(2);
  now = 60_000;
  await exports.pushDiscordActivity({ title: "Song", isPlaying: true });
  expect(login).toHaveBeenCalledTimes(2);
  now = 90_000;
  await exports.pushDiscordActivity({ title: "Song", isPlaying: true });
  expect(login).toHaveBeenCalledTimes(3);
});
