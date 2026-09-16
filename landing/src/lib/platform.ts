export type Platform = "mac" | "windows" | "linux" | "unknown";

/** Best-effort desktop OS detection for choosing which download to lead
 *  with. Phones and tablets deliberately land on "unknown": the mobile app
 *  is built from source, not downloaded. */
export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent.toLowerCase();
  if (/iphone|ipad|ipod|android/.test(ua)) return "unknown";
  const hinted = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData?.platform;
  const platform = (hinted ?? navigator.platform ?? "").toLowerCase();
  if (platform.includes("mac") || ua.includes("mac os")) return "mac";
  if (platform.includes("win") || ua.includes("windows")) return "windows";
  if (platform.includes("linux") || ua.includes("linux")) return "linux";
  return "unknown";
}

export const PLATFORM_LABEL: Record<Platform, string> = {
  mac: "macOS",
  windows: "Windows",
  linux: "Linux",
  unknown: "desktop",
};
