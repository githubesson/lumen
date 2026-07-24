const fs = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// The canonical core package is the sibling ../core. `npm run sync:core`
// vendors a copy into packages/music-library-core so that `file:` resolution
// and EAS uploads (which only ship the mobile project) keep working.
//
// When the sibling is present — i.e. any checkout of the monorepo — resolve
// straight to it and watch it, so editing core/src/** hot-reloads instead of
// silently bundling a stale vendored copy.
const siblingCoreRoot = path.resolve(__dirname, "..", "core");
const bundledCoreRoot = path.resolve(__dirname, "packages", "music-library-core");

const hasSiblingCore = fs.existsSync(path.join(siblingCoreRoot, "src", "index.ts"));
const hasBundledCore = fs.existsSync(path.join(bundledCoreRoot, "src", "index.ts"));

if (!hasSiblingCore && !hasBundledCore) {
  throw new Error(
    "@music-library/core is missing: neither ../core/src nor " +
      "packages/music-library-core/src exists. Run `npm run sync:core` " +
      "(it runs automatically on postinstall — did you install with " +
      "--ignore-scripts?).",
  );
}

const coreRoot = hasSiblingCore ? siblingCoreRoot : bundledCoreRoot;

if (hasSiblingCore) {
  config.watchFolders = [...(config.watchFolders ?? []), siblingCoreRoot];
}

// Mirror core/package.json "exports" — Metro's resolver does not read the
// subpath map for a source-only package aliased outside the project root.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  "@music-library/core": coreRoot,
};

const coreSubpathAliases = {
  "@music-library/core": path.join(coreRoot, "src", "index.ts"),
  "@music-library/core/api": path.join(coreRoot, "src", "api.ts"),
  "@music-library/core/storage": path.join(coreRoot, "src", "storage.ts"),
  "@music-library/core/events": path.join(coreRoot, "src", "events.ts"),
  "@music-library/core/format": path.join(coreRoot, "src", "format.ts"),
  "@music-library/core/auth": path.join(coreRoot, "src", "auth", "auth-core.tsx"),
  "@music-library/core/favorites": path.join(
    coreRoot,
    "src",
    "favorites",
    "favorites-core.tsx",
  ),
  "@music-library/core/player": path.join(coreRoot, "src", "player", "index.ts"),
};

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const alias = coreSubpathAliases[moduleName];
  if (alias) {
    return { type: "sourceFile", filePath: alias };
  }
  if (moduleName.startsWith("@music-library/core/player/")) {
    const sub = moduleName.slice("@music-library/core/player/".length);
    return {
      type: "sourceFile",
      filePath: path.join(coreRoot, "src", "player", `${sub}.ts`),
    };
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
