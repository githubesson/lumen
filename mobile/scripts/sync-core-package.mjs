import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const siblingCoreRoot = path.resolve(projectRoot, "..", "core");
const bundledCoreRoot = path.resolve(projectRoot, "packages", "music-library-core");

// --check does not write anything; it exits non-zero when the vendored copy is
// missing or differs from the sibling. CI runs it so core↔mobile drift fails a
// build instead of silently shipping a stale bundle.
const checkOnly = process.argv.includes("--check");

function removeIfExists(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath);
      continue;
    }
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function listFiles(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
        continue;
      }
      out.push(rel);
    }
  };
  walk(root, "");
  out.sort();
  return out;
}

function diffSrc(source, target) {
  if (!fs.existsSync(target)) return ["<missing packages/music-library-core/src>"];
  const sourceFiles = listFiles(source);
  const targetFiles = listFiles(target);
  const differences = [];
  for (const rel of sourceFiles) {
    if (!targetFiles.includes(rel)) {
      differences.push(`missing: ${rel}`);
      continue;
    }
    const a = fs.readFileSync(path.join(source, rel));
    const b = fs.readFileSync(path.join(target, rel));
    if (!a.equals(b)) differences.push(`stale: ${rel}`);
  }
  for (const rel of targetFiles) {
    if (!sourceFiles.includes(rel)) differences.push(`extra: ${rel}`);
  }
  return differences;
}

// The vendored copy is source-only: Metro compiles core/src directly, so core's
// devDependencies (react, typescript, vitest, ...) must NOT be mirrored here.
// Mirroring them made mobile/package-lock.json pin core's toolchain
// independently, where `npm ci` would silently install the locked versions and
// ignore any change to core/package.json.
function vendoredManifest(siblingPackage) {
  const manifest = { ...siblingPackage, private: true };
  delete manifest.devDependencies;
  delete manifest.peerDependencies;
  delete manifest.scripts;
  return manifest;
}

if (!fs.existsSync(siblingCoreRoot)) {
  if (checkOnly) {
    // EAS / standalone builds ship only mobile/, so the sibling is legitimately
    // absent there; the vendored copy is all we can verify.
    if (!fs.existsSync(path.join(bundledCoreRoot, "src", "index.ts"))) {
      console.error(
        "sync:core --check: neither ../core nor a vendored packages/music-library-core/src exists",
      );
      process.exit(1);
    }
    console.log("sync:core --check: sibling core absent, vendored copy present");
    process.exit(0);
  }
  console.log("sync:core: sibling core package not found, keeping bundled copy");
  process.exit(0);
}

const siblingPackage = JSON.parse(
  fs.readFileSync(path.join(siblingCoreRoot, "package.json"), "utf8"),
);
const manifest = `${JSON.stringify(vendoredManifest(siblingPackage), null, 2)}\n`;

if (checkOnly) {
  const differences = diffSrc(
    path.join(siblingCoreRoot, "src"),
    path.join(bundledCoreRoot, "src"),
  );
  const manifestPath = path.join(bundledCoreRoot, "package.json");
  if (!fs.existsSync(manifestPath) || fs.readFileSync(manifestPath, "utf8") !== manifest) {
    differences.push("stale: package.json");
  }
  if (differences.length > 0) {
    console.error("sync:core --check: vendored core is out of date with ../core");
    for (const line of differences) console.error(`  ${line}`);
    console.error("Run `npm run sync:core` in mobile/ and rebuild.");
    process.exit(1);
  }
  console.log("sync:core --check: vendored core matches ../core");
  process.exit(0);
}

fs.mkdirSync(bundledCoreRoot, { recursive: true });
removeIfExists(path.join(bundledCoreRoot, "src"));
copyDir(path.join(siblingCoreRoot, "src"), path.join(bundledCoreRoot, "src"));

fs.writeFileSync(path.join(bundledCoreRoot, "package.json"), manifest);

removeIfExists(path.join(bundledCoreRoot, "node_modules"));
removeIfExists(path.join(bundledCoreRoot, "package-lock.json"));

console.log("sync:core: bundled music-library-core refreshed");
