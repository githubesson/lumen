import * as Sentry from "@sentry/react-native";
import * as Updates from "expo-updates";

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN?.trim();

// No init call means no global error handler, native SDK startup, or uploads.
// Development reporting requires a separate explicit opt-in.
export const crashReportingEnabled = Boolean(
  dsn && (!__DEV__ || process.env.EXPO_PUBLIC_SENTRY_DEBUG === "1"),
);

if (crashReportingEnabled) {
  Sentry.init({
    dsn,
    environment: process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT || "production",
    sendDefaultPii: false,
    enableLogs: false,
    enableAutoPerformanceTracing: false,
    enableAutoSessionTracking: false,
    attachScreenshot: false,
    attachViewHierarchy: false,
    maxBreadcrumbs: 50,
    // Only record our explicit, structured breadcrumbs. Console arguments and
    // network URLs can contain session cookies, signed URLs, or server bodies.
    integrations: (defaults) =>
      defaults.filter((integration) =>
        !["Breadcrumbs", "HttpContext"].includes(integration.name),
      ),
    beforeBreadcrumb: (breadcrumb) =>
      breadcrumb.category?.startsWith("lumen.") ? breadcrumb : null,
    beforeSend: (event) => {
      delete event.user;
      delete event.request;
      return event;
    },
  });
  Sentry.setTags({
    "expo-update-id": Updates.updateId ?? "embedded",
    "expo-runtime-version": Updates.runtimeVersion ?? "unknown",
    "expo-update-channel": Updates.channel ?? "unknown",
    "expo-is-embedded-update": String(Updates.isEmbeddedLaunch),
  });
}

/** Explicitly captured failures should retain the original Error and stack. */
export function reportError(error: unknown): void {
  if (crashReportingEnabled) Sentry.captureException(error);
}

/** Pass only operational state; never URLs, credentials, or response bodies. */
export function recordCrashBreadcrumb(
  event: string,
  data: Record<string, string | number | boolean | null> = {},
): void {
  if (!crashReportingEnabled) return;
  Sentry.addBreadcrumb({ category: `lumen.${event}`, level: "info", data });
}

export function setCrashRoute(route: string): void {
  if (!crashReportingEnabled) return;
  Sentry.setTag("route", route);
  recordCrashBreadcrumb("navigation", { route });
}
