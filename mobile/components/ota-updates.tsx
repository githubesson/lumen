import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Constants from "expo-constants";
import * as Haptics from "expo-haptics";
import * as Updates from "expo-updates";
import { SymbolView } from "expo-symbols";
import { SETTINGS_INSET } from "./settings/settings-card";
import { otaStatus, otaStatusLabel, type OtaStatus } from "../lib/settings/ota-status";
import { useTheme, type ThemeTokens } from "../theme/theme";

/**
 * Rows for the settings Updates card: one "Lumen <version>" row with the
 * over-the-air status and a disclosure chevron, which a tap opens onto the
 * build details (which OTA bundle is actually running) and the manual check
 * that downloads one. Before anything has been checked the status reads
 * "Check for updates", and that tap runs the check as it opens. An update
 * that's downloaded or waiting shows as the exception: a badge on the row
 * and its action below, without opening anything.
 *
 * `expo-updates` is inert outside release builds (`Updates.isEnabled` is false
 * in the dev client), where every field below is undefined — so that case gets
 * a single explanatory row instead of a wall of dashes.
 */
export function OtaUpdateRows() {
  const theme = useTheme();
  const {
    currentlyRunning,
    isUpdateAvailable,
    isUpdatePending,
    isChecking,
    isDownloading,
    checkError,
    downloadError,
    lastCheckForUpdateTimeSinceRestart,
  } = Updates.useUpdates();
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const title = `Lumen ${Constants.expoConfig?.version ?? "—"}`;

  if (!Updates.isEnabled) {
    return (
      <>
        <Row label={title} value="" theme={theme} />
        <Note theme={theme}>
          Over-the-air updates are disabled in this build — you&apos;re running
          the bundle from Metro, not a published update.
        </Note>
      </>
    );
  }

  const check = async () => {
    void Haptics.selectionAsync();
    setActionError(null);
    try {
      const result = await Updates.checkForUpdateAsync();
      if (result.isAvailable) await Updates.fetchUpdateAsync();
    } catch (error) {
      setActionError(updateErrorMessage(error, "Could not check for updates."));
    }
  };

  const restart = async () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setActionError(null);
    try {
      await Updates.reloadAsync();
    } catch (error) {
      setActionError(updateErrorMessage(error, "Could not restart into the update."));
    }
  };

  const busy = isChecking || isDownloading;
  const error =
    actionError ?? (checkError ?? downloadError)?.message ?? null;
  const status = otaStatus({
    isUpdatePending,
    isDownloading,
    isChecking,
    isUpdateAvailable,
    error,
    lastCheckForUpdateTimeSinceRestart,
  });
  const statusLabel = otaStatusLabel(status);
  // A downloaded or announced update keeps its action in view.
  const waiting = isUpdatePending || isUpdateAvailable;
  const checkOffered = status.kind === "unknown";

  return (
    <>
      <Pressable
        onPress={() => {
          // Nothing checked yet: the row's "Check for updates" does just that
          // (with its own haptic), and opens to show how it goes.
          if (!expanded && checkOffered) {
            setExpanded(true);
            void check();
            return;
          }
          void Haptics.selectionAsync();
          setExpanded((open) => !open);
        }}
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${statusLabel}`}
        accessibilityHint={
          expanded
            ? "Hides the build details."
            : checkOffered
              ? "Checks for an update and shows the build details."
              : "Shows the build details."
        }
        accessibilityState={{ expanded }}
        style={({ pressed }) => [
          styles.row,
          {
            paddingHorizontal: SETTINGS_INSET,
            paddingVertical: 12,
            backgroundColor: pressed ? theme.color.bgElev2 : "transparent",
          },
        ]}
      >
        <Text style={{ color: theme.color.fg, fontSize: 16 }}>{title}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}>
          <StatusTrailing status={status} label={statusLabel} theme={theme} />
          <SymbolView
            name={expanded ? "chevron.up" : "chevron.down"}
            size={12}
            weight="semibold"
            tintColor={theme.color.fgMuted}
          />
        </View>
      </Pressable>

      {expanded ? (
        <>
          <Row
            label="Update"
            value={
              currentlyRunning.isEmbeddedLaunch
                ? "Embedded in build"
                : shortId(currentlyRunning.updateId)
            }
            theme={theme}
            border
          />
          <Row
            label="Published"
            value={formatDate(currentlyRunning.createdAt)}
            theme={theme}
            border
          />
          <Row
            label="Channel"
            value={currentlyRunning.channel ?? "—"}
            theme={theme}
            border
          />
          <Row
            label="Runtime"
            // Fingerprint runtime versions are 40 hex chars — only the head is
            // useful for eyeballing whether two installs match.
            value={shortId(currentlyRunning.runtimeVersion)}
            theme={theme}
            border
          />
        </>
      ) : null}

      {expanded || waiting ? (
        <Pressable
          onPress={() => {
            if (busy) return;
            void (isUpdatePending ? restart() : check());
          }}
          disabled={busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy, busy }}
          style={({ pressed }) => [
            styles.row,
            {
              paddingHorizontal: SETTINGS_INSET,
              paddingVertical: 14,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: theme.color.separator,
              backgroundColor: pressed ? theme.color.bgElev2 : "transparent",
              opacity: busy ? 0.65 : 1,
            },
          ]}
        >
          <View style={{ gap: 2, flex: 1 }}>
            <Text style={{ color: theme.color.accent, fontSize: 16 }}>
              {isUpdatePending
                ? "Restart to apply update"
                : isDownloading
                  ? "Downloading update…"
                  : isChecking
                    ? "Checking…"
                    : isUpdateAvailable
                      ? "Download update"
                      : "Check for updates"}
            </Text>
            <Text style={{ color: theme.color.fgMuted, fontSize: 13 }}>
              {isUpdatePending
                ? "Downloaded and ready — restarts the app."
                : isUpdateAvailable
                  ? "An update is available."
                  : lastCheckForUpdateTimeSinceRestart
                    ? `Up to date — checked ${formatTime(lastCheckForUpdateTimeSinceRestart)}`
                    : "Updates also install automatically on launch."}
            </Text>
          </View>
          {busy ? <ActivityIndicator color={theme.color.fgMuted} /> : null}
        </Pressable>
      ) : null}

      {currentlyRunning.isEmergencyLaunch ? (
        <Note theme={theme} tone="danger" border>
          {currentlyRunning.emergencyLaunchReason ??
            "The last update failed to launch, so the app fell back to the bundle embedded in the build."}
        </Note>
      ) : null}
      {error ? (
        <Note theme={theme} tone="danger" border={!currentlyRunning.isEmergencyLaunch}>
          {error}
        </Note>
      ) : null}
    </>
  );
}

/** The row's status: a badge for a ready update, a spinner while busy, else a word (an accent one for an action). */
function StatusTrailing({
  status,
  label,
  theme,
}: {
  status: OtaStatus;
  label: string;
  theme: ThemeTokens;
}) {
  if (status.kind === "ready") {
    return (
      <View
        style={{
          backgroundColor: theme.color.accent,
          borderRadius: 11,
          paddingHorizontal: 9,
          height: 22,
          justifyContent: "center",
        }}
      >
        <Text style={{ color: theme.color.onAccent, fontSize: 13, fontWeight: "600" }}>
          {label}
        </Text>
      </View>
    );
  }
  const busy = status.kind === "checking" || status.kind === "downloading";
  const color =
    status.kind === "available" || status.kind === "unknown"
      ? theme.color.accent
      : status.kind === "error"
        ? theme.color.danger
        : theme.color.fgMuted;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Text numberOfLines={1} style={{ color, fontSize: 16 }}>
        {label}
      </Text>
      {busy ? <ActivityIndicator size="small" color={theme.color.fgMuted} /> : null}
    </View>
  );
}

/** expo-updates' own reason (its errors are never an ApiError), else `fallback`. */
function updateErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** First 12 characters of a UUID / fingerprint hash — enough to compare two installs. */
function shortId(value?: string | null) {
  if (!value) return "—";
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function formatDate(date?: Date | null) {
  if (!date) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTime(date: Date) {
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function Row({
  label,
  value,
  theme,
  border,
}: {
  label: string;
  value: string;
  theme: ThemeTokens;
  border?: boolean;
}) {
  return (
    <View
      style={[
        styles.row,
        {
          paddingHorizontal: SETTINGS_INSET,
          paddingVertical: 12,
          borderTopWidth: border ? StyleSheet.hairlineWidth : 0,
          borderTopColor: theme.color.separator,
        },
      ]}
    >
      <Text style={{ color: theme.color.fg, fontSize: 16 }}>{label}</Text>
      {value ? (
        <Text
          style={{ color: theme.color.fgMuted, fontSize: 16, flexShrink: 1 }}
          numberOfLines={1}
        >
          {value}
        </Text>
      ) : null}
    </View>
  );
}

function Note({
  children,
  theme,
  tone,
  border,
}: {
  children: React.ReactNode;
  theme: ThemeTokens;
  tone?: "danger";
  /** Hairline above, when the note follows a row. */
  border?: boolean;
}) {
  return (
    <Text
      style={{
        color: tone === "danger" ? theme.color.danger : theme.color.fgMuted,
        fontSize: 13,
        paddingHorizontal: SETTINGS_INSET,
        paddingTop: border ? 12 : 0,
        paddingBottom: 12,
        borderTopWidth: border ? StyleSheet.hairlineWidth : 0,
        borderTopColor: theme.color.separator,
      }}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
});
