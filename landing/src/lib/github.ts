import { useEffect, useState } from "react";
import { REPO } from "./site";

export interface RepoInfo {
  stars: number | null;
  release: { tag: string; url: string; prerelease: boolean } | null;
}

const CACHE_KEY = "lumen-landing-gh";
const CACHE_MS = 30 * 60 * 1000;

function readCache(): RepoInfo | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { at, info } = JSON.parse(raw) as { at: number; info: RepoInfo };
    return Date.now() - at < CACHE_MS ? info : null;
  } catch {
    return null;
  }
}

async function load(): Promise<RepoInfo> {
  const [repo, releases] = await Promise.all([
    fetch(`https://api.github.com/repos/${REPO}`).then((r) => (r.ok ? r.json() : null)),
    fetch(`https://api.github.com/repos/${REPO}/releases?per_page=1`).then((r) => (r.ok ? r.json() : null)),
  ]);
  const latest = Array.isArray(releases) ? releases[0] : null;
  return {
    stars: typeof repo?.stargazers_count === "number" ? repo.stargazers_count : null,
    release: latest
      ? { tag: latest.tag_name, url: latest.html_url, prerelease: Boolean(latest.prerelease) }
      : null,
  };
}

/** Stars and newest release (prereleases included, since there's no stable
 *  tag yet). Unauthenticated API, so it's cached per tab and every consumer
 *  renders fine without it. */
export function useRepoInfo(): RepoInfo {
  const [info, setInfo] = useState<RepoInfo>(() => readCache() ?? { stars: null, release: null });

  useEffect(() => {
    if (readCache()) return;
    let cancelled = false;
    load()
      .then((next) => {
        if (cancelled) return;
        setInfo(next);
        try {
          sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), info: next }));
        } catch {
          /* storage full or disabled */
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return info;
}
