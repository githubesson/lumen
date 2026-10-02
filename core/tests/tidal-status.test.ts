import { describe, expect, it } from "vitest";
import type { TidalAutoDownloadStatus, TidalStatus } from "../src/api";
import {
  tidalAutoDownloadProblems,
  tidalStatusDetails,
  tidalStatusErrors,
} from "../src/tidal/status";
import {
  normalizeTidalVerificationURL,
  tidalAuthorizationTimeoutMs,
  tidalSignInMessage,
} from "../src/tidal/use-tidal-device-login";

function status(overrides: Partial<TidalStatus> = {}): TidalStatus {
  return {
    connected: true,
    management_supported: true,
    accounts: [],
    ...overrides,
  };
}

function autoDownload(
  overrides: Partial<TidalAutoDownloadStatus> = {},
): TidalAutoDownloadStatus {
  return {
    subdir: "TIDAL",
    ffmpeg: true,
    summary: { playlists: 0, queued: 0, failed: 0, saved: 0 },
    recent: [],
    ...overrides,
  };
}

describe("TIDAL status", () => {
  it("fills in the proxy's defaults", () => {
    expect(tidalStatusDetails(null)).toEqual({
      proxy: "not configured",
      country: "US",
      quality: "LOSSLESS",
      version: "unknown",
    });
    expect(
      tidalStatusDetails(
        status({
          proxy_url: "http://hifi:8000",
          country_code: "GB",
          quality: "HI_RES_LOSSLESS",
          version: "2.4",
        }),
      ),
    ).toEqual({
      proxy: "http://hifi:8000",
      country: "GB",
      quality: "HI_RES_LOSSLESS",
      version: "2.4",
    });
  });

  it("lists every error once, the screen's first", () => {
    expect(tidalStatusErrors(null, undefined)).toEqual([]);
    expect(
      tidalStatusErrors(
        "Could not unlink the TIDAL account.",
        status({ error: "proxy unreachable", management_error: "extension missing" }),
      ),
    ).toEqual([
      "Could not unlink the TIDAL account.",
      "proxy unreachable",
      "extension missing",
    ]);
    expect(
      tidalStatusErrors(
        "proxy unreachable",
        status({ error: "proxy unreachable", management_error: "" }),
      ),
    ).toEqual(["proxy unreachable"]);
  });

  it("reports every auto-download problem, not just the first", () => {
    expect(tidalAutoDownloadProblems(null)).toEqual([]);
    expect(tidalAutoDownloadProblems(autoDownload())).toEqual([]);
    expect(
      tidalAutoDownloadProblems(
        autoDownload({ ffmpeg: false, destination_error: "permission denied" }),
      ),
    ).toEqual([
      "ffmpeg is not installed on the server, so downloads are paused.",
      "Download folder unavailable: permission denied",
    ]);
    expect(
      tidalAutoDownloadProblems(autoDownload({ destination_error: "missing" })),
    ).toEqual(["Download folder unavailable: missing"]);
  });
});

describe("TIDAL device login helpers", () => {
  it("adds https to scheme-less TIDAL links only", () => {
    expect(normalizeTidalVerificationURL(" link.tidal.com/ABCDE ")).toBe(
      "https://link.tidal.com/ABCDE",
    );
    expect(normalizeTidalVerificationURL("//tidal.com/device")).toBe(
      "https://tidal.com/device",
    );
    expect(normalizeTidalVerificationURL("https://link.tidal.com/X")).toBe(
      "https://link.tidal.com/X",
    );
    expect(normalizeTidalVerificationURL("eviltidal.com/x")).toBe(
      "eviltidal.com/x",
    );
    expect(normalizeTidalVerificationURL("javascript:alert(1)")).toBe(
      "javascript:alert(1)",
    );
    expect(normalizeTidalVerificationURL("  ")).toBe("");
  });

  it("waits until a little after the code expires", () => {
    const now = Date.parse("2026-10-02T12:00:00.000Z");
    expect(tidalAuthorizationTimeoutMs("2026-10-02T12:05:00.000Z", now)).toBe(
      305_000,
    );
    // An already-expired code still gets one poll's worth of time.
    expect(tidalAuthorizationTimeoutMs("2026-10-02T11:00:00.000Z", now)).toBe(
      2500,
    );
    expect(tidalAuthorizationTimeoutMs("", now)).toBeUndefined();
  });

  it("describes how a sign-in ended", () => {
    expect(
      tidalSignInMessage({
        state: "linked",
        account: { id: "a", user_id: "1234", removable: true },
      }),
    ).toBe("TIDAL account 1234 linked.");
    expect(tidalSignInMessage({ state: "linked" })).toBe("TIDAL account linked.");
    expect(tidalSignInMessage({ state: "denied" })).toBe("TIDAL sign-in denied.");
    expect(tidalSignInMessage({ state: "expired", message: "Code expired." })).toBe(
      "Code expired.",
    );
  });
});
