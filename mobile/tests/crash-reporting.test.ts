import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  setTags: vi.fn(),
  setTag: vi.fn(),
}));
vi.mock("@sentry/react-native", () => sentry);
vi.mock("expo-updates", () => ({
  updateId: "ota-123", runtimeVersion: "runtime-123",
  channel: "production", isEmbeddedLaunch: false,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("__DEV__", false);
  vi.stubEnv("EXPO_PUBLIC_SENTRY_DSN", "");
  vi.stubEnv("EXPO_PUBLIC_SENTRY_DEBUG", "0");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("optional crash reporting", () => {
  it("does not initialize or call Sentry without a DSN", async () => {
    const reporting = await import("../lib/crash-reporting");
    reporting.reportError(new Error("local only"));
    reporting.setCrashRoute("(tabs)/library");
    reporting.recordCrashBreadcrumb("playback", { isPlaying: true });
    expect(reporting.crashReportingEnabled).toBe(false);
    for (const fn of Object.values(sentry)) expect(fn).not.toHaveBeenCalled();
  });

  it("does not report in development unless explicitly enabled", async () => {
    vi.stubGlobal("__DEV__", true);
    vi.stubEnv("EXPO_PUBLIC_SENTRY_DSN", "https://public@example.com/1");
    await import("../lib/crash-reporting");
    expect(sentry.init).not.toHaveBeenCalled();
    vi.resetModules();
    vi.stubEnv("EXPO_PUBLIC_SENTRY_DEBUG", "1");
    await import("../lib/crash-reporting");
    expect(sentry.init).toHaveBeenCalledTimes(1);
  });

  it("preserves the original error and identifies the OTA update", async () => {
    vi.stubEnv("EXPO_PUBLIC_SENTRY_DSN", "https://public@example.com/1");
    const reporting = await import("../lib/crash-reporting");
    const error = new Error("test failure");
    reporting.reportError(error);
    expect(sentry.captureException).toHaveBeenCalledWith(error);
    expect(sentry.setTags).toHaveBeenCalledWith(expect.objectContaining({
      "expo-update-id": "ota-123", "expo-is-embedded-update": "false",
    }));
    reporting.setCrashRoute("playlist/[id]");
    expect(sentry.setTag).toHaveBeenCalledWith("route", "playlist/[id]");
  });

  it("excludes automatic console/network breadcrumbs and user/request data", async () => {
    vi.stubEnv("EXPO_PUBLIC_SENTRY_DSN", "https://public@example.com/1");
    await import("../lib/crash-reporting");
    const options = sentry.init.mock.calls[0]![0];
    expect(options.beforeBreadcrumb({ category: "console", message: "secret" })).toBeNull();
    expect(options.beforeBreadcrumb({ category: "http", data: { url: "secret" } })).toBeNull();
    const breadcrumb = { category: "lumen.playback", data: { isPlaying: true } };
    expect(options.beforeBreadcrumb(breadcrumb)).toBe(breadcrumb);
    const event = { exception: { values: [] }, user: { email: "private" }, request: { headers: { Cookie: "secret" } } };
    expect(options.beforeSend(event)).toEqual({ exception: { values: [] } });
    expect(options.enableLogs).toBe(false);
    expect(options.tracesSampleRate).toBeUndefined();
    expect(options.replaysOnErrorSampleRate).toBeUndefined();
  });
});
