// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createLocalProxy } from "../electron/local-proxy";

it("reuses a saved origin, caches assets and falls back safely on port collisions", async () => {
  const distDir = await mkdtemp(join(tmpdir(), "lumen-proxy-test-"));
  await mkdir(join(distDir, "assets"));
  await writeFile(join(distDir, "index.html"), "<html>Lumen</html>");
  await writeFile(join(distDir, "assets", "app-hash.js"), "export default 1");
  const options = { distDir, getBackendUrl: () => "" };
  const first = createLocalProxy(options);
  const second = createLocalProxy(options);
  try {
    const savedPort = await first.start(0);
    const asset = await fetch(`http://127.0.0.1:${savedPort}/assets/app-hash.js`);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const document = await fetch(`http://127.0.0.1:${savedPort}/library`);
    expect(document.headers.get("cache-control")).toBe("no-cache");
    const fallbackPort = await second.start(savedPort);
    expect(fallbackPort).not.toBe(savedPort);
    first.close();
    expect(await first.start(savedPort)).toBe(savedPort);
  } finally {
    first.close(); second.close();
    await rm(distDir, { recursive: true, force: true });
  }
});
