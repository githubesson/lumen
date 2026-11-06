// Prints DOM boxes for calibration (not a screenshot scene).
import { test } from "playwright/test";
import { go, ready, signedIn } from "../../../frontend/tests/ui/helpers";
test("rects", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { electron: unknown }).electron = new Proxy({ isElectron: true, platform: "win32", getConfig: async () => ({ backendUrl: location.origin }), getTweaks: async () => ({ tweaks: {}, audioSinkId: "" }), getSignOutIntent: async () => false, setSignOutIntent: async () => {}, getUpdateStatus: undefined, onUpdateStatus: undefined, setDiscordActivity: undefined } as Record<string, unknown>, { get: (t, k) => (typeof k === "string" && !(k in t) && k !== "then" ? async () => ({ ok: false }) : t[k as string]), has: () => true });
    document.addEventListener("DOMContentLoaded", () => document.documentElement.setAttribute("data-electron", "true"));
  });
  await signedIn(page);
  await go(page, process.env.RECT_PATH ?? "/favorites");
  await page.getByText(process.env.RECT_WAIT ?? "most recently favorited first").first().waitFor();
  await page.waitForTimeout(300);
  const out = await page.evaluate((sel) => [...document.querySelectorAll(sel)].slice(0, 4).map((e) => {
    const r = e.getBoundingClientRect(); return `${e.className} "${(e.textContent ?? "").slice(0, 24)}" ${r.x.toFixed(2)},${r.y.toFixed(2)} ${r.width.toFixed(2)}x${r.height.toFixed(2)}`; }), process.env.RECT_SEL ?? ".track-title, .track-artist, td");
  console.log(out.join("\n"));
});
