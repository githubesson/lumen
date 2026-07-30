// electron-builder packaging config. JS instead of YAML so optional pieces
// can be decided at build time — most importantly the private radio add-on,
// which YAML could only express as an always-required path (every build on a
// machine without _local/ failed until the block was hand-removed).
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// Optional private add-on: the FH6 radio bridge DLL + config live in a local,
// untracked folder. Bundled when present, silently skipped when not.
const RADIO_DIST = path.join(
  __dirname,
  "..",
  "_local",
  "fh6-spotify-mod",
  "lumen-radio",
  "dist",
);

/**
 * Sign, notarize, and staple the DMG container itself. electron-builder
 * notarizes the .app inside, but leaves the generated DMG unsigned; Apple
 * requires the container to be notarized too for a clean Gatekeeper pass.
 *
 * Runs only when both CSC_NAME and APPLE_KEYCHAIN_PROFILE are set (the same
 * env that turns on app signing/notarization) — dev builds skip it. Note the
 * .blockmap is generated before this re-sign, so it goes stale; the app has
 * no auto-updater, so nothing consumes it.
 */
async function signAndNotarizeDmg(result) {
  const dmgs = result.artifactPaths.filter((p) => p.endsWith(".dmg"));
  if (dmgs.length === 0) return [];
  const identity = process.env.CSC_NAME;
  const profile = process.env.APPLE_KEYCHAIN_PROFILE;
  if (!identity || !profile) {
    console.log(
      "dmg-notarize: CSC_NAME / APPLE_KEYCHAIN_PROFILE not set — DMG left unsigned (fine for dev builds, not for distribution)",
    );
    return [];
  }
  const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
  for (const dmg of dmgs) {
    console.log(`dmg-notarize: signing and notarizing ${path.basename(dmg)}`);
    run("codesign", ["--force", "--timestamp", "--sign", identity, dmg]);
    run("codesign", ["--verify", "--verbose=2", dmg]);
    const out = execFileSync(
      "xcrun",
      [
        "notarytool",
        "submit",
        dmg,
        "--keychain-profile",
        profile,
        "--wait",
        "--output-format",
        "json",
      ],
      { encoding: "utf8" },
    );
    console.log(out);
    const status = JSON.parse(out).status;
    if (status !== "Accepted") {
      throw new Error(
        `dmg-notarize: notarization of ${path.basename(dmg)} ended with status "${status}" — do not distribute this artifact`,
      );
    }
    run("xcrun", ["stapler", "staple", dmg]);
    run("xcrun", ["stapler", "validate", dmg]);
  }
  return [];
}

/** @type {import("electron-builder").Configuration} */
const config = {
  appId: "com.lumen.music-library",
  productName: "Lumen",
  copyright: "",
  // Release destination for CI (`--publish always`); local `electron:build*`
  // scripts pass `--publish never` so nothing uploads from a dev machine.
  publish: {
    provider: "github",
    owner: "githubesson",
    repo: "lumen",
    releaseType: "release",
  },
  directories: {
    output: "release",
  },
  asar: true,
  files: [
    "package.json",
    "electron/package.json",
    "electron/setup.html",
    "electron/build/**/*",
    "dist/**/*",
    "!**/*.map",
  ],
  // On macOS the hook bundles electron/assets/Assets.car (when present) so
  // macOS 26 renders the light/dark/tinted icon variants natively — generate
  // it with `npm run icons`. No-op on Windows and while the file is absent.
  afterPack: "scripts/mac-appearance-icon.cjs",
  afterAllArtifactBuild: signAndNotarizeDmg,
  mac: {
    // Static fallback for macOS < 26; appearance variants come from Assets.car.
    icon: "electron/assets/icon.icns",
    // Release artifact: one DMG that runs natively on both Apple Silicon and
    // Intel — browsers can't tell the two apart from the user agent, so the
    // download button needs a single mac artifact. Local builds override this
    // with `--mac dmg` (host arch only) for speed; see electron:build:mac.
    target: [
      {
        target: "dmg",
        arch: ["universal"],
      },
    ],
  },
  win: {
    icon: "electron/assets/icon.ico",
    target: [
      { target: "portable", arch: ["x64"] },
      { target: "nsis", arch: ["x64"] },
    ],
  },
  dmg: {
    background: "electron/assets/dmg-background.png",
    window: {
      width: 540,
      height: 380,
    },
    iconSize: 80,
    iconTextSize: 12,
    contents: [
      { x: 130, y: 220, type: "file" },
      { x: 410, y: 220, type: "link", path: "/Applications" },
    ],
  },
  portable: {
    artifactName: "${productName}-${version}-portable.${ext}",
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    artifactName: "${productName}-${version}-setup.${ext}",
  },
};

if (fs.existsSync(RADIO_DIST)) {
  console.log("packaging: bundling FH6 radio add-on from _local/");
  config.extraResources = [
    {
      from: "../_local/fh6-spotify-mod/lumen-radio/dist",
      to: "lumen-radio",
      filter: ["version.dll", "fh6-radio/config.toml"],
    },
  ];
}

module.exports = config;
