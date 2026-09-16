import { URL } from "node:url";

/** Opt-in uploads must have credentials before publishing an OTA update. */
export function sentryUploadEnvironment(env = process.env) {
  if (env.SENTRY_UPLOAD_SOURCEMAPS !== "1") return null;
  const missing = ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"]
    .filter((key) => !env[key]?.trim());
  if (missing.length) {
    throw new Error(`Sentry uploads enabled but missing ${missing.join(", ")}. No update was published.`);
  }
  const sentryUrl = env.SENTRY_URL || "https://sentry.io/";
  try {
    if (new URL(sentryUrl).protocol !== "https:") throw new Error();
  } catch {
    throw new Error("SENTRY_URL must be a valid HTTPS URL when Sentry uploads are enabled.");
  }
  return { ...env, SENTRY_URL: sentryUrl };
}
