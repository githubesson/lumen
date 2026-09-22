import * as path from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { LocalProxy } from "./local-proxy";

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// Only relative /api/ paths are accepted. The absolute-URL passthrough that
// used to live here handed the renderer a way to make the main process attach
// the app's session cookie to a request for any host it liked — dead code for
// the real UI (lib/download.ts only ever passes /api/tracks/<id>/stream), but
// a live capability for anything else running in the renderer.
export function exportDownloadUrl(localProxy: LocalProxy, input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Missing download URL");
  if (!trimmed.startsWith("/api/")) {
    throw new Error("Export URL must be an API path");
  }
  if (!localProxy.port) throw new Error("Local app proxy is not ready");
  return `http://127.0.0.1:${localProxy.port}${trimmed}`;
}

// The session cookie is scoped to the local proxy origin and must not survive a
// redirect off it. downloadToFile re-derives the header per hop from this.
function isAppOrigin(localProxy: LocalProxy, target: URL): boolean {
  return (
    target.protocol === "http:" &&
    (target.hostname === "127.0.0.1" || target.hostname === "localhost") &&
    target.port === String(localProxy.port)
  );
}

function sanitizeExportFilename(name: string): string {
  const sanitized = path
    .basename(name)
    // Control characters are exactly what we want to strip from a filename.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
  return sanitized || "track";
}

export async function uniqueExportPath(folder: string, filename: string): Promise<string> {
  const safe = sanitizeExportFilename(filename);
  const parsed = path.parse(safe);
  const stem = parsed.name || "track";
  const ext = parsed.ext;
  for (let i = 0; i < 10000; i += 1) {
    const candidate = path.join(
      folder,
      i === 0 ? `${stem}${ext}` : `${stem} (${i})${ext}`,
    );
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error("Could not choose a unique filename");
}

export function downloadToFile(
  localProxy: LocalProxy,
  urlString: string,
  dest: string,
  cookieHeader: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = (currentUrl: string, redirects: number) => {
      const target = new URL(currentUrl);
      const lib = target.protocol === "https:" ? https : http;
      // Re-evaluated per hop rather than captured once in the closure: a
      // redirect to any other host used to receive the session cookie too.
      const sendCookie = cookieHeader && isAppOrigin(localProxy, target);
      const req = lib.get(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === "https:" ? 443 : 80),
          path: target.pathname + target.search,
          headers: {
            Accept: "application/octet-stream,*/*",
            ...(sendCookie ? { Cookie: cookieHeader } : {}),
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const location = res.headers.location;
          if (status >= 300 && status < 400 && location) {
            res.resume();
            if (redirects <= 0) {
              reject(new Error("Too many redirects"));
              return;
            }
            attempt(new URL(location, target).toString(), redirects - 1);
            return;
          }
          if (status < 200 || status >= 300) {
            res.resume();
            reject(new Error(`HTTP ${status || "error"}`));
            return;
          }

          const out = fs.createWriteStream(dest, { flags: "wx" });
          pipeline(res, out)
            .then(() => resolve())
            .catch(async (e) => {
              try {
                await fsp.rm(dest, { force: true });
              } catch {
                // Best-effort cleanup; the original stream error is clearer.
              }
              reject(e);
            });
        },
      );
      req.on("error", reject);
      req.setTimeout(120000, () => {
        req.destroy(new Error("Download timed out"));
      });
    };
    attempt(urlString, 5);
  });
}
