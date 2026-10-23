import { describe, expect, it } from "vitest";
import { otaStatus, otaStatusLabel, type OtaState } from "../lib/settings/ota-status";

const idle: OtaState = {
  isUpdatePending: false,
  isDownloading: false,
  isChecking: false,
  isUpdateAvailable: false,
  error: null,
  lastCheckForUpdateTimeSinceRestart: null,
};
const checkedAt = new Date("2026-10-23T14:41:00Z");

describe("otaStatus", () => {
  it("is up to date once a check since launch found nothing", () => {
    const status = otaStatus({ ...idle, lastCheckForUpdateTimeSinceRestart: checkedAt });
    expect(status).toEqual({ kind: "current", checkedAt });
    expect(otaStatusLabel(status)).toBe("Up to date");
  });

  it("claims nothing before any check", () => {
    const status = otaStatus(idle);
    expect(status.kind).toBe("unknown");
    expect(otaStatusLabel(status)).toBe("");
  });

  it("puts a downloaded update first, whatever else is going on", () => {
    const status = otaStatus({
      ...idle,
      isUpdatePending: true,
      isChecking: true,
      isUpdateAvailable: true,
      error: "Could not restart into the update.",
    });
    expect(status.kind).toBe("ready");
    expect(otaStatusLabel(status)).toBe("Update ready");
  });

  it("shows work under way before what an earlier check found", () => {
    expect(otaStatus({ ...idle, isDownloading: true, isUpdateAvailable: true }).kind).toBe(
      "downloading",
    );
    expect(
      otaStatus({ ...idle, isChecking: true, lastCheckForUpdateTimeSinceRestart: checkedAt }).kind,
    ).toBe("checking");
  });

  it("flags an available update, then an error, over the last good check", () => {
    expect(otaStatus({ ...idle, isUpdateAvailable: true, error: "x" }).kind).toBe("available");
    const failed = otaStatus({
      ...idle,
      error: "Network request failed",
      lastCheckForUpdateTimeSinceRestart: checkedAt,
    });
    expect(failed.kind).toBe("error");
    expect(otaStatusLabel(failed)).toBe("Couldn't update");
  });
});
