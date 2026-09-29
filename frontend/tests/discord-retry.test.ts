// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";

function load(login: ReturnType<typeof vi.fn>, request = vi.fn().mockResolvedValue(undefined)) {
  const compiled = ts.transpileModule(readFileSync(new URL("../electron/discord-presence.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const clock = { now: 0 };
  const timers: Array<{ at: number; fn: () => void; cleared: boolean }> = [];
  const destroy = vi.fn().mockResolvedValue(undefined);
  const handlers = new Map<string, () => void>();
  const exports = {} as typeof import("../electron/discord-presence");
  runInNewContext(compiled, {
    exports, Date: { now: () => clock.now }, console: { log() {}, warn() {} },
    process: { pid: 1 },
    setTimeout: (fn: () => void, ms: number) => {
      const timer = { at: clock.now + ms, fn, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer: { cleared: boolean }) => { timer.cleared = true; },
    require: () => ({ Client: class { on(event: string, fn: () => void) { handlers.set(event, fn); } login = login; destroy = destroy; request = request; } }),
  });
  /** Advance the clock and run timers that came due. */
  const advance = async (to: number) => {
    clock.now = to;
    for (const timer of timers.splice(0)) {
      if (timer.cleared) continue;
      if (timer.at <= to) timer.fn();
      else timers.push(timer);
    }
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { exports, clock, destroy, request, advance, handlers, pendingTimers: () => timers.filter((t) => !t.cleared) };
}

it("backs off failed Discord connections and destroys each failed client", async () => {
  const login = vi.fn().mockRejectedValue(new Error("Discord is not running"));
  const { exports, clock, destroy } = load(login);
  exports.configureDiscordPresence({ clientId: "fixture" });
  for (let push = 0; push < 5; push++) await exports.pushDiscordActivity({ title: "Song", isPlaying: true });
  expect(login).toHaveBeenCalledTimes(1);
  expect(destroy).toHaveBeenCalledTimes(1);
  clock.now = 30_000;
  await exports.pushDiscordActivity({ title: "Song", isPlaying: true });
  expect(login).toHaveBeenCalledTimes(2);
  clock.now = 60_000;
  await exports.pushDiscordActivity({ title: "Song", isPlaying: true });
  expect(login).toHaveBeenCalledTimes(2);
  clock.now = 90_000;
  await exports.pushDiscordActivity({ title: "Song", isPlaying: true });
  expect(login).toHaveBeenCalledTimes(3);
});

it("resends the newest failed update once the backoff ends, without a new event", async () => {
  const login = vi.fn().mockRejectedValueOnce(new Error("Discord is not running")).mockResolvedValue(undefined);
  const { exports, request, advance, pendingTimers } = load(login);
  exports.configureDiscordPresence({ clientId: "fixture" });
  expect(await exports.pushDiscordActivity({ title: "Old", isPlaying: true, elapsedSec: 0 })).toMatchObject({ ok: false });
  expect(await exports.pushDiscordActivity({ title: "Song", isPlaying: true, elapsedSec: 10 })).toMatchObject({ ok: false });
  expect(pendingTimers()).toHaveLength(1);
  await advance(30_000);
  expect(login).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenCalledOnce();
  const activity = request.mock.calls[0][1].activity;
  expect(activity.details).toBe("Song");
  // Started 10 s in, 30 s before the resend: 40 s elapsed.
  expect(activity.timestamps.start).toBe(-10);
});

it("drops a pending resend when presence is cleared", async () => {
  const login = vi.fn().mockRejectedValueOnce(new Error("Discord is not running")).mockResolvedValue(undefined);
  const { exports, request, advance } = load(login);
  exports.configureDiscordPresence({ clientId: "fixture" });
  await exports.pushDiscordActivity({ title: "Song", isPlaying: true });
  await exports.clearDiscordActivity();
  await advance(30_000);
  expect(request).not.toHaveBeenCalled();
});

it("reconnects after Discord disconnects mid-track and restores the same presence", async () => {
  const login = vi.fn().mockResolvedValue(undefined);
  const { exports, request, advance, handlers } = load(login);
  exports.configureDiscordPresence({ clientId: "fixture" });
  await exports.pushDiscordActivity({ title: "Song", isPlaying: true, elapsedSec: 0 });
  expect(request).toHaveBeenCalledOnce();
  handlers.get("disconnected")!();
  await advance(30_000);
  expect(login).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenCalledTimes(2);
  const activity = request.mock.calls[1][1].activity;
  expect(activity.details).toBe("Song");
  // Still the original start time: the track kept playing through the outage.
  expect(activity.timestamps.start).toBe(0);
});
