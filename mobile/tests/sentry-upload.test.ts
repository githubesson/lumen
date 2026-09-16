import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const shell = vi.hoisted(() => ({ run: vi.fn(() => "test commit") }));
vi.mock("node:child_process", () => ({ execFileSync: shell.run }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("process", { ...process, argv: ["node", "publish-update.mjs", "preview", "test"] });
  for (const name of ["SENTRY_UPLOAD_SOURCEMAPS", "SENTRY_ORG", "SENTRY_PROJECT", "SENTRY_AUTH_TOKEN"]) {
    vi.stubEnv(name, "");
  }
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("optional release uploads", () => {
  it("publishes normally without any Sentry credentials", async () => {
    await import("../scripts/publish-update.mjs");
    expect(shell.run).toHaveBeenCalledTimes(2);
    expect(shell.run.mock.calls[1]?.[1]).toContain("update");
  });

  it("catches incomplete opt-in before publishing", async () => {
    vi.stubEnv("SENTRY_UPLOAD_SOURCEMAPS", "1");
    await expect(import("../scripts/publish-update.mjs")).rejects.toThrow("SENTRY_AUTH_TOKEN");
    expect(shell.run).not.toHaveBeenCalled();
  });

  it("uploads the maps from the same export after publishing", async () => {
    vi.stubEnv("SENTRY_UPLOAD_SOURCEMAPS", "1");
    vi.stubEnv("SENTRY_ORG", "org");
    vi.stubEnv("SENTRY_PROJECT", "project");
    vi.stubEnv("SENTRY_AUTH_TOKEN", "private-token");
    await import("../scripts/publish-update.mjs");
    expect(shell.run).toHaveBeenCalledTimes(3);
    expect(shell.run.mock.calls[2]?.[1]).toEqual([
      expect.stringContaining("expo-upload-sourcemaps.js"), "dist",
    ]);
    expect(shell.run.mock.calls[2]?.[2].env.SENTRY_URL).toBe("https://sentry.io/");
  });

  it("keeps upload hooks out of default config and never embeds the token", () => {
    const require = createRequire(import.meta.url);
    const source = readFileSync(new URL("../app.config.js", import.meta.url), "utf8");
    const module = { exports: undefined as any };
    vm.runInNewContext(source, {
      module, __dirname: "/mobile", process,
      require: (id: string) => id === "fs" ? { existsSync: () => false } : require(id),
    });
    const base = { plugins: ["expo-router"] };
    expect(module.exports({ config: base }).plugins).toEqual(["expo-router"]);
    vi.stubEnv("SENTRY_UPLOAD_SOURCEMAPS", "1");
    vi.stubEnv("SENTRY_AUTH_TOKEN", "must-not-be-bundled");
    const config = module.exports({ config: base });
    expect(config.plugins[1][0]).toBe("@sentry/react-native/expo");
    expect(JSON.stringify(config)).not.toContain("must-not-be-bundled");
  });
});
