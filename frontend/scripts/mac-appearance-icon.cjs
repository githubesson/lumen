// electron-builder afterPack hook: bundle the compiled Icon Composer assets
// (Assets.car) into the macOS app and point Info.plist at them, so macOS 26+
// renders the icon's light/dark/tinted appearance variants natively.
//
// Assets.car is generated from resources/icon.icon on a Mac with Xcode 26 —
// see scripts/generate-mac-icon-assets.sh. While the file is absent this hook
// is a no-op, so Windows builds and pre-Assets.car mac builds are unaffected.
// Runs before code signing, so the added resource and plist edit get signed.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const car = path.join(__dirname, "..", "electron", "assets", "Assets.car");
  if (!fs.existsSync(car)) {
    console.log(
      "mac-appearance-icon: electron/assets/Assets.car not found — skipping " +
        "(generate it with scripts/generate-mac-icon-assets.sh on a Mac with Xcode 26)",
    );
    return;
  }
  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  fs.copyFileSync(car, path.join(app, "Contents", "Resources", "Assets.car"));
  const plist = path.join(app, "Contents", "Info.plist");
  // CFBundleIconName must match the icon name inside Assets.car (the .icon
  // bundle's basename). CFBundleIconFile/.icns stays as the pre-Tahoe fallback.
  execFileSync("plutil", ["-replace", "CFBundleIconName", "-string", "icon", plist]);
  console.log("mac-appearance-icon: bundled Assets.car, set CFBundleIconName=icon");
};
