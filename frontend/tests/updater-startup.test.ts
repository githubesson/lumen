// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Exercise the same CommonJS loading boundary used by the packaged app.
const compiled = ts.transpileModule(
  readFileSync(new URL("../electron/updater.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function loadManager(packaged = true, failImport = false) {
  const updater = { on: vi.fn(), setFeedURL: vi.fn(), checkForUpdates: vi.fn().mockResolvedValue(null) };
  const loadUpdater = vi.fn(() => {
    if (failImport) throw new Error("Missing updater");
    return { autoUpdater: updater };
  });
  const exports = {} as typeof import("../electron/updater");
  runInNewContext(compiled, {
    exports,
    require: (id: string) => {
      if (id === "electron-updater") return loadUpdater();
      if (id === "electron") return {
        app: { isPackaged: packaged, getVersion: () => "1.0.0" },
        BrowserWindow: { getAllWindows: () => [] },
      };
      throw new Error(`Unexpected module: ${id}`);
    },
    URL, console, setTimeout, setInterval,
    process: { platform: "linux", env: {} },
  });
  const manager = new exports.DesktopUpdateManager("https://github.com/example/lumen");
  manager.configure({ branch: "main", repoUrl: "https://github.com/example/lumen" });
  return { manager, updater, loadUpdater };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it("does not load the updater during boot and loads it once on the delayed check", async () => {
  const { manager, updater, loadUpdater } = loadManager();
  manager.startAutomaticChecks();
  manager.startAutomaticChecks();
  expect(loadUpdater).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(14_999);
  expect(loadUpdater).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(loadUpdater).toHaveBeenCalledTimes(1);
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
});

it("uses the latest preferences when a manual check happens before the timer", async () => {
  const { manager, updater, loadUpdater } = loadManager();
  manager.configure({ branch: "dev", repoUrl: "https://github.com/other/app" });
  expect(loadUpdater).not.toHaveBeenCalled();
  await manager.check();
  expect(updater.setFeedURL).toHaveBeenCalledWith({ provider: "github", owner: "other", repo: "app", channel: "dev" });
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
});

it("never loads the dependency for unsupported builds", async () => {
  const { manager, loadUpdater } = loadManager(false);
  manager.startAutomaticChecks();
  await manager.check();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(manager.getStatus().state).toBe("unsupported");
  expect(loadUpdater).not.toHaveBeenCalled();
});

it("reports a deferred import failure and lets the user retry", async () => {
  const { manager, loadUpdater } = loadManager(true, true);
  expect(loadUpdater).not.toHaveBeenCalled();
  expect((await manager.check()).state).toBe("error");
  expect(manager.getStatus().canCheck).toBe(true);
  await manager.check();
  expect(loadUpdater).toHaveBeenCalledTimes(2);
});
