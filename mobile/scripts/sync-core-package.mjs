import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const siblingCoreRoot = path.resolve(projectRoot, "..", "core");
const bundledCoreRoot = path.resolve(projectRoot, "packages", "music-library-core");

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

if (!fs.existsSync(siblingCoreRoot)) {
  console.log("sync:core: sibling core package not found, keeping bundled copy");
  process.exit(0);
}

fs.mkdirSync(bundledCoreRoot, { recursive: true });
removeIfExists(path.join(bundledCoreRoot, "src"));
copyDir(path.join(siblingCoreRoot, "src"), path.join(bundledCoreRoot, "src"));

const siblingPackage = JSON.parse(
  fs.readFileSync(path.join(siblingCoreRoot, "package.json"), "utf8"),
);

const bundledPackage = {
  ...siblingPackage,
  private: true,
  devDependencies: siblingPackage.devDependencies ?? {},
};

fs.writeFileSync(
  path.join(bundledCoreRoot, "package.json"),
  `${JSON.stringify(bundledPackage, null, 2)}\n`,
);

removeIfExists(path.join(bundledCoreRoot, "node_modules"));
removeIfExists(path.join(bundledCoreRoot, "package-lock.json"));

console.log("sync:core: bundled music-library-core refreshed");
