// Fill app.json / eas.json with your own deployment details.
//
//   npm run configure                       interactive prompts
//   npm run configure -- --from cfg.json    non-interactive, answers from a JSON file
//
// Answer file shape (every key optional):
//   {
//     "apiBaseUrl": "https://music.example.com",
//     "bundleIdentifier": "com.yourname.lumen",
//     "owner": "your-expo-username",
//     "easProjectId": "00000000-0000-0000-0000-000000000000",
//     "instagramAppId": "",
//     "ascAppId": ""
//   }
//
// Pressing Enter on a prompt keeps the current value; entering "-" clears it.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appJsonPath = path.join(projectRoot, "app.json");
const easJsonPath = path.join(projectRoot, "eas.json");

// eas.json is untracked (it carries personal project/app IDs) — recreate it
// from this template when missing.
const EAS_TEMPLATE = {
  cli: {
    version: ">= 18.8.0",
    appVersionSource: "remote",
  },
  build: {
    development: {
      developmentClient: true,
      distribution: "internal",
    },
    preview: {
      distribution: "internal",
    },
    production: {
      autoIncrement: true,
    },
  },
};

const appJson = JSON.parse(fs.readFileSync(appJsonPath, "utf8"));
const easJson = fs.existsSync(easJsonPath)
  ? JSON.parse(fs.readFileSync(easJsonPath, "utf8"))
  : structuredClone(EAS_TEMPLATE);
const expo = appJson.expo;

const FIELDS = [
  {
    key: "apiBaseUrl",
    label: "Backend base URL (your deployment, e.g. https://music.example.com)",
    get: () => expo.extra?.apiBaseUrl ?? "",
    set: (v) => {
      expo.extra = { ...expo.extra, apiBaseUrl: v };
    },
  },
  {
    key: "bundleIdentifier",
    label: "iOS bundle identifier / Android package (e.g. com.yourname.lumen)",
    get: () => expo.ios?.bundleIdentifier ?? "",
    set: (v) => {
      expo.ios = { ...expo.ios, bundleIdentifier: v };
      if (v) expo.android = { ...expo.android, package: v };
      else if (expo.android) delete expo.android.package;
    },
  },
  {
    key: "owner",
    label: "Expo account username (owner — blank to use your logged-in account)",
    get: () => expo.owner ?? "",
    set: (v) => {
      if (v) expo.owner = v;
      else delete expo.owner;
    },
  },
  {
    key: "easProjectId",
    label: "EAS project ID (blank to skip — `eas init` can create one later)",
    get: () => expo.extra?.eas?.projectId ?? "",
    set: (v) => {
      if (v) expo.extra = { ...expo.extra, eas: { projectId: v } };
      else if (expo.extra?.eas) delete expo.extra.eas;
    },
  },
  {
    key: "instagramAppId",
    label: "Instagram/Facebook app ID for story sharing (blank to disable)",
    get: () => expo.extra?.instagramAppId ?? "",
    set: (v) => {
      expo.extra = { ...expo.extra, instagramAppId: v };
    },
  },
  {
    key: "ascAppId",
    label: "App Store Connect app ID for `eas submit` (blank to skip)",
    get: () => easJson.submit?.production?.ios?.ascAppId ?? "",
    set: (v) => {
      if (v) easJson.submit = { production: { ios: { ascAppId: v } } };
      else delete easJson.submit;
    },
  },
];

function applyAnswer(field, raw) {
  if (raw === undefined || raw === "") return; // keep current
  field.set(raw === "-" ? "" : raw.trim());
}

const fromFlag = process.argv.indexOf("--from");
if (fromFlag !== -1) {
  const answerPath = process.argv[fromFlag + 1];
  if (!answerPath) {
    console.error("configure: --from needs a path to a JSON answer file");
    process.exit(1);
  }
  const answers = JSON.parse(fs.readFileSync(path.resolve(projectRoot, answerPath), "utf8"));
  for (const field of FIELDS) {
    if (field.key in answers) applyAnswer(field, String(answers[field.key] ?? "-") || "-");
  }
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("Configure Lumen mobile — Enter keeps the current value, '-' clears it.\n");
  for (const field of FIELDS) {
    const current = field.get();
    const answer = await rl.question(`${field.label}\n  [${current || "unset"}] > `);
    applyAnswer(field, answer);
  }
  rl.close();
}

fs.writeFileSync(appJsonPath, `${JSON.stringify(appJson, null, 2)}\n`);
fs.writeFileSync(easJsonPath, `${JSON.stringify(easJson, null, 2)}\n`);
console.log("\nconfigure: wrote app.json and eas.json");
if (!expo.extra?.apiBaseUrl) {
  console.log("configure: warning — apiBaseUrl is unset; the app has no backend to talk to");
  console.log("           (you can also set EXPO_PUBLIC_API_BASE_URL at build time instead)");
}
