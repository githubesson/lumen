/** Opt-in uploads must have credentials before publishing an OTA update. */
export function sentryUploadEnvironment(env = process.env) {
  if (env.SENTRY_UPLOAD_SOURCEMAPS !== "1") return null;
  const missing = ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"]
    .filter((key) => !env[key]?.trim());
  if (missing.length) {
    throw new Error(`Sentry uploads enabled but missing ${missing.join(", ")}. No update was published.`);
  }
  return { ...env, SENTRY_URL: env.SENTRY_URL || "https://sentry.io/" };
}
