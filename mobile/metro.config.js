const fs = require("node:fs");
const path = require("node:path");
const { getSentryExpoConfig } = require("@sentry/react-native/metro");

// Debug IDs make source maps usable for builds and OTA updates. This only
// changes bundling metadata; it does not initialize reporting or upload data.
const config = getSentryExpoConfig(__dirname, {
  includeWebReplay: false,
  enableSourceContextInDevelopment: false,
});

// The canonical core package is the sibling ../core. `npm run sync:core`
// vendors a copy into packages/music-library-core so that `file:` resolution
// keeps working; postinstall refreshes it from the sibling.
//
// In a working checkout, resolve straight to the sibling and watch it, so
// editing core/src/** hot-reloads instead of silently bundling a stale
// vendored copy.
const siblingCoreRoot = path.resolve(__dirname, "..", "core");
const bundledCoreRoot = path.resolve(
  __dirname,
  "packages",
  "music-library-core",
);

const hasSiblingCore = fs.existsSync(
  path.join(siblingCoreRoot, "src", "index.ts"),
);
const hasBundledCore = fs.existsSync(
  path.join(bundledCoreRoot, "src", "index.ts"),
);

if (!hasSiblingCore && !hasBundledCore) {
  throw new Error(
    "@music-library/core is missing: neither ../core/src nor " +
      "packages/music-library-core/src exists. Run `npm run sync:core` " +
      "(it runs automatically on postinstall — did you install with " +
      "--ignore-scripts?).",
  );
}

// A cloud build gets the whole monorepo (see the repository's .easignore), so
// the sibling is present there too — but Metro can only hash files its crawler
// reached, and pulling core/src in from outside the project root fails the
// bundle with "Failed to get the SHA-1". Builds therefore use the vendored
// copy, which postinstall has just refreshed from that same sibling, so it is
// the identical source either way.
const isBundleBuild =
  !!process.env.EAS_BUILD ||
  !!process.env.CI ||
  process.env.CONFIGURATION === "Release" ||
  process.env.NODE_ENV === "production" ||
  process.env.BUNDLE_COMMAND === "export:embed";
const useSiblingCore = hasSiblingCore && !(isBundleBuild && hasBundledCore);

const coreRoot = useSiblingCore ? siblingCoreRoot : bundledCoreRoot;
const appNodeModules = path.resolve(__dirname, "node_modules");

if (useSiblingCore) {
  config.watchFolders = [...(config.watchFolders ?? []), siblingCoreRoot];
}

// The sibling core package has its own devDependencies for browser tests.
// Keep Metro from walking up from ../core/src into ../core/node_modules;
// every app dependency (especially React) must come from the mobile project.
config.resolver.disableHierarchicalLookup = true;
config.resolver.nodeModulesPaths = [appNodeModules];

config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  "@music-library/core": coreRoot,
};

// Resolve core imports from core's own package.json "exports" map, read at
// startup, so a new core subpath works here without a matching edit. This
// used to be a hand-kept copy that listed 7 of the 20 subpaths.
const coreExports = JSON.parse(
  fs.readFileSync(path.join(coreRoot, "package.json"), "utf8"),
).exports;
const coreSubpathAliases = {};
const coreWildcardAliases = [];
for (const [subpath, target] of Object.entries(coreExports)) {
  if (typeof target !== "string") continue;
  const name =
    subpath === "."
      ? "@music-library/core"
      : `@music-library/core/${subpath.slice(2)}`;
  const star = name.indexOf("*");
  if (star === -1) {
    coreSubpathAliases[name] = path.join(coreRoot, target);
  } else {
    coreWildcardAliases.push({ prefix: name.slice(0, star), target });
  }
}

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const alias = coreSubpathAliases[moduleName];
  if (alias) {
    return { type: "sourceFile", filePath: alias };
  }
  for (const { prefix, target } of coreWildcardAliases) {
    if (moduleName.startsWith(prefix)) {
      const match = moduleName.slice(prefix.length);
      return {
        type: "sourceFile",
        filePath: path.join(coreRoot, target.replace("*", match)),
      };
    }
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
