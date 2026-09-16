import { RELEASES_API } from "./site";
import type { Platform } from "./platform";

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  published_at: string;
  assets: GitHubAsset[];
}

export type TargetId =
  "mac-dmg" | "win-setup" | "win-portable" | "linux-appimage" | "linux-deb";

export interface DownloadTarget {
  id: TargetId;
  platform: Platform;
  label: string;
  detail: string;
  url: string;
  size: number;
}

export interface ReleaseInfo {
  version: string;
  tag: string;
  url: string;
  prerelease: boolean;
  publishedAt: Date;
  targets: DownloadTarget[];
}

// Asset names come from electron-builder's targets in
// frontend/electron-builder.cjs: Lumen-<version>-universal.dmg,
// -setup.exe, -portable.exe, -x86_64.AppImage, -amd64.deb.
const TARGETS: ReadonlyArray<{
  id: TargetId;
  platform: Platform;
  label: string;
  detail: string;
  test: (name: string) => boolean;
}> = [
  {
    id: "mac-dmg",
    platform: "mac",
    label: "macOS",
    detail: "Universal DMG",
    test: (n) => n.endsWith(".dmg"),
  },
  {
    id: "win-setup",
    platform: "windows",
    label: "Windows",
    detail: "Installer",
    test: (n) => n.endsWith("-setup.exe"),
  },
  {
    id: "win-portable",
    platform: "windows",
    label: "Windows",
    detail: "Portable",
    test: (n) => n.endsWith("-portable.exe"),
  },
  {
    id: "linux-appimage",
    platform: "linux",
    label: "Linux",
    detail: "AppImage",
    test: (n) => n.endsWith(".AppImage"),
  },
  {
    id: "linux-deb",
    platform: "linux",
    label: "Linux",
    detail: "Debian package",
    test: (n) => n.endsWith(".deb"),
  },
];

function toInfo(release: GitHubRelease): ReleaseInfo {
  const targets: DownloadTarget[] = [];
  for (const t of TARGETS) {
    const asset = release.assets.find((a) => t.test(a.name));
    if (asset) {
      targets.push({
        id: t.id,
        platform: t.platform,
        label: t.label,
        detail: t.detail,
        url: asset.browser_download_url,
        size: asset.size,
      });
    }
  }
  return {
    version: release.tag_name.replace(/^v/, ""),
    tag: release.tag_name,
    url: release.html_url,
    prerelease: release.prerelease,
    publishedAt: new Date(release.published_at),
    targets,
  };
}

/** Newest stable release with desktop assets, or the newest pre-release
 *  when no stable tag exists yet. Returns null when nothing usable is
 *  published so the caller can fall back to the releases page. */
export async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  const res = await fetch(RELEASES_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);
  const releases = (await res.json()) as GitHubRelease[];
  const usable = releases
    .filter((r) => !r.draft)
    .map(toInfo)
    .filter((r) => r.targets.length > 0)
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  return usable.find((r) => !r.prerelease) ?? usable[0] ?? null;
}

export function formatSize(bytes: number): string {
  const mb = bytes / 1_000_000;
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(0)} MB`;
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
