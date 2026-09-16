/* global __dirname */
// Optional local overlay for app.json. If app.local.json exists (gitignored),
// its values are deep-merged over the committed config — so personal
// deployment details (owner, bundle identifier, API URL, EAS/Instagram IDs)
// stay out of the repo while `expo`/`eas` commands still see them.
// Without the file, the committed app.json is used as-is.
const fs = require("fs");
const path = require("path");

function merge(base, override) {
  if (
    base === null ||
    override === null ||
    Array.isArray(base) ||
    Array.isArray(override) ||
    typeof base !== "object" ||
    typeof override !== "object"
  ) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const key of Object.keys(override)) {
    out[key] = merge(base[key], override[key]);
  }
  return out;
}

module.exports = ({ config }) => {
  const localPath = path.join(__dirname, "app.local.json");
  const local = fs.existsSync(localPath)
    ? JSON.parse(fs.readFileSync(localPath, "utf8"))
    : {};
  const resolved = merge(config, local.expo ?? local);

  // Independent of runtime reporting: ordinary builds need no Sentry account.
  // Never include SENTRY_AUTH_TOKEN in config: Expo embeds config in the app.
  if (process.env.SENTRY_UPLOAD_SOURCEMAPS === "1") {
    resolved.plugins = [
      ...(resolved.plugins ?? []),
      ["@sentry/react-native/expo", {
        organization: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        url: process.env.SENTRY_URL || "https://sentry.io/",
      }],
    ];
  }
  return resolved;
};
