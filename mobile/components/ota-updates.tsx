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
import { errorMessage } from "@music-library/core";
import { useTheme, type ThemeTokens } from "../theme/theme";

/**
 * Rows for the settings "Updates" card: which OTA bundle is actually running,
 * plus a manual check that downloads one and restarts into it.
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

  const appVersion = Constants.expoConfig?.version ?? "—";

  if (!Updates.isEnabled) {
    return (
      <>
        <Row label="App version" value={appVersion} theme={theme} />
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
      setActionError(errorMessage(error, "Could not check for updates."));
    }
  };

  const restart = async () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setActionError(null);
    try {
      await Updates.reloadAsync();
    } catch (error) {
      setActionError(errorMessage(error, "Could not restart into the update."));
    }
  };

  const busy = isChecking || isDownloading;
  const error =
    actionError ?? (checkError ?? downloadError)?.message ?? null;

  return (
    <>
      <Row label="App version" value={appVersion} theme={theme} />
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

      <Pressable
        onPress={() => {
          if (busy) return;
          void (isUpdatePending ? restart() : check());
        }}
        disabled={busy}
        style={({ pressed }) => [
          styles.row,
          {
            paddingHorizontal: theme.space.md,
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

      {currentlyRunning.isEmergencyLaunch ? (
        <Note theme={theme} tone="danger">
          {currentlyRunning.emergencyLaunchReason ??
            "The last update failed to launch, so the app fell back to the bundle embedded in the build."}
        </Note>
      ) : null}
      {error ? (
        <Note theme={theme} tone="danger">
          {error}
        </Note>
      ) : null}
    </>
  );
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
          paddingHorizontal: theme.space.md,
          paddingVertical: 12,
          borderTopWidth: border ? StyleSheet.hairlineWidth : 0,
          borderTopColor: theme.color.separator,
        },
      ]}
    >
      <Text style={{ color: theme.color.fg, fontSize: 16 }}>{label}</Text>
      <Text
        style={{ color: theme.color.fgMuted, fontSize: 16 }}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

function Note({
  children,
  theme,
  tone,
}: {
  children: React.ReactNode;
  theme: ThemeTokens;
  tone?: "danger";
}) {
  return (
    <Text
      style={{
        color: tone === "danger" ? theme.color.danger : theme.color.fgMuted,
        fontSize: 13,
        paddingHorizontal: theme.space.md,
        paddingBottom: 12,
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
