// Every reference scene against the port: renders each scene the reference
// spec names (scenes.ref.ts) with the Rune build, diffs it with its shot in
// out/ref, and lists them worst first.
//
//   node native/tools/sweep.mjs [--bin target/release/lumen] [--theme dark] [--only <regex>]
//
// Shoot the references first (tools/reference: playwright test), and run the
// mock API (tools/mock-server.ts). A scene with a script in
// tools/reference/scripts/<scene>.json plays it and is shot at 1 s. Renders
// land in out/sweep, with each scene's diff image beside it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = (name, d) => (args.includes(name) ? args[args.indexOf(name) + 1] : d);
const bin = path.resolve(root, flag("--bin", "target/release/lumen"));
const theme = flag("--theme", "dark");
const only = flag("--only") ? new RegExp(flag("--only")) : null;

// Each scene object's name, as the spec writes it.
const spec = fs.readFileSync(path.join(root, "tools/reference/scenes.ref.ts"), "utf8");
const scenes = [];
const re = /\{\s*name: "([^"]+)"([\s\S]*?)(?=\n\s*\{\s*name: "|\n\];)/g;
for (let m; (m = re.exec(spec)); ) {
  scenes.push({ name: m[1] });
}

// Spec scenes the port plays from another scene: a scroll of the content
// (px, or "end"), or one of tools/reference/scripts. A size comes from the
// reference shot itself.
const end = "end";
const VARIANTS = {
  "library-scrolled": { scene: "library", scroll: 600 },
  "library-medium": { scene: "library" },
  "library-narrow": { scene: "library" },
  "drawer-narrow": { scene: "drawer" },
  "replay-hover": { scene: "replay", script: "replay-hover" },
  "replay-medium": { scene: "replay" },
  "replay-narrow": { scene: "replay" },
  "replay-small": { scene: "replay" },
  "replay-mid": { scene: "replay", scroll: 420 },
  "replay-bottom": { scene: "replay", scroll: end },
  "replay-month-bottom": { scene: "replay-month", scroll: end },
  "replay-all-tracks": { scene: "replay-all-tracks", scroll: 380 },
  "replay-all-tracks-bottom": { scene: "replay-all-tracks", scroll: end },
  "replay-medium-bottom": { scene: "replay", scroll: end },
  "replay-narrow-mid": { scene: "replay", scroll: 420 },
  "replay-narrow-bottom": { scene: "replay", scroll: end },
  "replay-small-mid": { scene: "replay", scroll: 420 },
  "replay-small-bottom": { scene: "replay", scroll: end },
  "favorites-hover": { scene: "favorites", script: "favorites-hover" },
  "favorites-select": { scene: "favorites", script: "favorites-select" },
  "favorites-menu": { scene: "favorites", script: "favorites-menu" },
  "favorites-menu-many": { scene: "favorites", script: "favorites-menu-many" },
  tooltip: { scene: "favorites", script: "tooltip" },
  "admin-lib-2": { scene: "admin", scroll: 600 },
  "admin-lib-3": { scene: "admin", scroll: 1200 },
  "admin-lib-4": { scene: "admin", scroll: 1800 },
  "admin-lib-5": { scene: "admin", scroll: 2400 },
  "admin-errors": { scene: "admin-errors", scroll: 300 },
  "admin-downloads": { scene: "admin-downloads", scroll: 1200 },
  // The dialog opens over the scrolled page: scroll, then press Unlink.
  "admin-unlink": { scene: "admin", script: "admin-unlink", at: 1.5 },
  "admin-link-flow": { scene: "admin-link-flow", scroll: 600 },
};

const out = path.join(root, "out/sweep");
fs.mkdirSync(out, { recursive: true });

/// A script scrolling the content `by` px (or to its end) in a window `w`×`h`.
function scrollScript(by, w, h) {
  const file = path.join(out, `scroll-${by}-${w}x${h}.json`);
  const dy = by === end ? -100000 : -by;
  const events = [
    { t: 0.1, type: "scroll", x: Math.round(w * 0.6), y: Math.round(h / 2), dx: 0, dy, dur: 0.2 },
    { t: 0.5, type: "move", x: 1, y: 1 },
  ];
  fs.writeFileSync(file, JSON.stringify({ events }));
  return file;
}
const rows = [];
for (const s of scenes) {
  if (only && !only.test(s.name)) continue;
  const ref = path.join(root, `out/ref/${s.name}-${theme}.png`);
  if (!fs.existsSync(ref)) {
    rows.push({ name: s.name, note: "no reference" });
    continue;
  }
  // The shot's own size: a scene may resize its window (the mini player).
  const png = fs.readFileSync(ref);
  const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  const size = `${w}x${h}`;
  const shot = path.join(out, `${s.name}-${theme}.png`);
  fs.rmSync(shot, { force: true });
  const v = VARIANTS[s.name] ?? { scene: s.name };
  const script =
    v.scroll !== undefined ? scrollScript(v.scroll, w, h) : path.join(root, `tools/reference/scripts/${v.script ?? s.name}.json`);
  const extra = fs.existsSync(script) ? ["--script", script, "--at", String(v.at ?? 1.0)] : [];
  try {
    execFileSync(bin, ["--snap", shot, "--scene", v.scene, "--size", size, "--scale", "1", "--theme", theme, ...extra], {
      cwd: root,
      env: { ...process.env, LUMEN_DATA_DIR: path.join(root, "out/data") },
      stdio: "pipe",
      timeout: 120_000,
    });
  } catch (e) {
    const why = String(e.stderr ?? e.message).split("\n").find((l) => /error|panic|unknown/i.test(l)) ?? "failed";
    rows.push({ name: s.name, note: why.slice(0, 100) });
    continue;
  }
  let res;
  try {
    res = execFileSync("node", [path.join(root, "tools/diff.mjs"), ref, shot, path.join(out, `${s.name}-${theme}`)], { encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    rows.push({ name: s.name, note: String(e.stderr || e.message).trim().split("\n")[0].slice(0, 100) });
    continue;
  }
  const m = res.match(/([\d.]+)% differ >8, ([\d.]+)% differ >32/);
  rows.push({ name: s.name, d8: m ? +m[1] : NaN, d32: m ? +m[2] : NaN });
}
rows.sort((a, b) => (b.d32 ?? -1) - (a.d32 ?? -1));
for (const r of rows) {
  console.log(r.note ? `${r.name.padEnd(32)} ${r.note}` : `${r.name.padEnd(32)} ${r.d8.toFixed(2).padStart(6)}% >8  ${r.d32.toFixed(2).padStart(6)}% >32`);
}
