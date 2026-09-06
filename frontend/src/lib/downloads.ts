// Resolve desktop-app download links from the project's GitHub Releases.
// The release workflow publishes Windows installer/portable executables, a
// universal macOS DMG, and Linux AppImage/deb packages for every version tag.
// The latest-release API is public and CORS-enabled, so the browser can query
// it directly.

const RELEASES_LATEST_API =
  "https://api.github.com/repos/githubesson/lumen/releases/latest";
const RELEASES_PAGE = "https://github.com/githubesson/lumen/releases/latest";

export type DesktopPlatform = "windows" | "mac" | "linux" | "other";

export function detectDesktopPlatform(): DesktopPlatform {
  const ua = navigator.userAgent;
  if (/windows/i.test(ua)) return "windows";
  if (/macintosh|mac os x/i.test(ua)) return "mac";
  if (/linux/i.test(ua) && !/android/i.test(ua)) return "linux";
  return "other";
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

let cachedAssets: ReleaseAsset[] | null = null;

async function latestReleaseAssets(): Promise<ReleaseAsset[]> {
  if (cachedAssets) return cachedAssets;
  const res = await fetch(RELEASES_LATEST_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`releases api ${res.status}`);
  const release = (await res.json()) as { assets?: ReleaseAsset[] };
  cachedAssets = release.assets ?? [];
  return cachedAssets;
}

/**
 * Direct download URL for the visitor's platform, or the releases page when
 * the platform is unknown or the lookup fails.
 */
export async function desktopDownloadUrl(): Promise<string> {
  const platform = detectDesktopPlatform();
  if (platform === "other") return RELEASES_PAGE;
  try {
    const assets = await latestReleaseAssets();
    const match =
      platform === "windows"
        ? assets.find((a) => a.name.endsWith("-setup.exe"))
        : platform === "mac"
          ? assets.find((a) => a.name.endsWith(".dmg"))
          : assets.find((a) => a.name.endsWith(".AppImage"));
    return match?.browser_download_url ?? RELEASES_PAGE;
  } catch {
    return RELEASES_PAGE;
  }
}

/** Kick off the platform-appropriate download (or open the releases page). */
export async function startDesktopDownload(): Promise<void> {
  const url = await desktopDownloadUrl();
  if (url === RELEASES_PAGE) {
    window.open(url, "_blank", "noopener");
    return;
  }
  // Direct asset URL: navigating triggers the download without leaving the
  // page or flashing a blank tab.
  window.location.href = url;
}
