#!/usr/bin/env node
/**
 * Package the exported app into a distributable DMG.
 *
 * Uses hdiutil directly rather than a packaging dependency: the layout is a
 * folder holding the app and an /Applications alias, which is all the classic
 * drag-to-install window is.
 *
 * Run `scripts/build-release.sh` first. Signing the DMG as well as the app is
 * what stops Gatekeeper flagging the download itself.
 *
 * Usage:
 *   node scripts/make-dmg.mjs
 *
 * Environment:
 *   SIGN_IDENTITY   "Developer ID Application: …" to sign and staple the DMG
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPath = path.join(projectRoot, 'build/release/export/LumenMac.app');
const stagingDir = path.join(projectRoot, 'build/release/dmg');
const dmgPath = path.join(projectRoot, 'build/release/Lumen.dmg');

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

if (!fs.existsSync(appPath)) {
  console.error(
    `No app at ${appPath}\nRun scripts/build-release.sh first.`,
  );
  process.exit(1);
}

const version =
  JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
    .version ?? '0.0.0';

console.log('==> Staging');
fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });
run('ditto', [appPath, path.join(stagingDir, 'LumenMac.app')]);
// The alias is what makes the window a drag-to-install target.
run('ln', ['-s', '/Applications', path.join(stagingDir, 'Applications')]);

console.log('==> Building DMG');
fs.rmSync(dmgPath, { force: true });
run('hdiutil', [
  'create',
  '-volname',
  `Lumen ${version}`,
  '-srcfolder',
  stagingDir,
  '-ov',
  '-format',
  'UDZO',
  dmgPath,
]);

const identity = process.env.SIGN_IDENTITY;
if (identity) {
  console.log('==> Signing DMG');
  run('codesign', ['--sign', identity, '--timestamp', dmgPath]);
  console.log('==> Stapling DMG');
  // The app was stapled already; stapling the DMG covers the download itself.
  run('xcrun', ['stapler', 'staple', dmgPath]);
} else {
  console.log('==> SIGN_IDENTITY not set, leaving the DMG unsigned');
}

console.log(`\nDone: ${dmgPath}`);
