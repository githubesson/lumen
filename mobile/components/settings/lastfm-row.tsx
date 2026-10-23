import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import * as WebBrowser from "expo-web-browser";
import { lastFMConnectionState, useLastFMConnection } from "@music-library/core";
import { SETTINGS_INSET } from "./settings-card";
import { showActionMenu } from "../../lib/action-menu";
import { useTheme } from "../../theme/theme";

/**
 * Last.fm scrobbling: connect when it isn't, and when it is, the account it
 * scrobbles as, with Disconnect a confirming tap away in an action sheet.
 * Waiting for approval, a server without Last.fm, and errors read as they
 * did on the old card.
 */
export function LastFmRow({ border }: { border?: boolean }) {
  const theme = useTheme();
  const { status, busy, error, connect, disconnect } = useLastFMConnection({
    pendingBeforeOpen: true,
    openAuthorization: (url) =>
      WebBrowser.openBrowserAsync(url, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      }),
  });
  const state = lastFMConnectionState(status, error);
  const connected = !!status?.connected;
  const username = status?.username || "your account";

  const onPress = () => {
    void Haptics.selectionAsync();
    if (connected) {
      showActionMenu({
        title: "Last.fm",
        message: state.description,
        items: [
          {
            label: "Disconnect",
            destructive: true,
            onPress: () => void disconnect(),
          },
        ],
        tintColor: theme.color.accent,
        userInterfaceStyle: theme.scheme,
      });
    } else if (status?.configured) {
      void connect();
    }
  };

  return (
    <View
      style={{
        borderTopWidth: border ? StyleSheet.hairlineWidth : 0,
        borderTopColor: theme.color.separator,
      }}
    >
      <Pressable
        onPress={onPress}
        disabled={busy || !status?.configured}
        accessibilityRole="button"
        accessibilityLabel={
          connected ? `Last.fm, scrobbling as ${username}` : `Last.fm, ${state.description}`
        }
        accessibilityHint={
          connected
            ? "Shows the option to disconnect."
            : status?.configured
              ? "Connects your Last.fm account."
              : undefined
        }
        accessibilityState={{ disabled: busy || !status?.configured, busy }}
        style={({ pressed }) => [
          styles.row,
          {
            backgroundColor: pressed ? theme.color.bgElev2 : "transparent",
            opacity: busy ? 0.65 : 1,
          },
        ]}
      >
        <View style={styles.lead}>
          <SymbolView name="waveform.path" size={18} tintColor={theme.color.fg} />
          <View style={{ flexShrink: 1, gap: 2 }}>
            <Text style={{ color: theme.color.fg, fontSize: 16 }}>Last.fm</Text>
            {connected ? null : (
              <Text style={{ color: theme.color.fgMuted, fontSize: 13 }}>
                {state.description}
              </Text>
            )}
          </View>
        </View>
        {busy ? (
          <ActivityIndicator color={theme.color.fgMuted} />
        ) : connected ? (
          <View style={styles.trail}>
            <Text
              numberOfLines={1}
              style={{ color: theme.color.fgMuted, fontSize: 16, flexShrink: 1 }}
            >
              {username}
            </Text>
            <SymbolView name="chevron.right" size={14} tintColor={theme.color.fgMuted} />
          </View>
        ) : status?.configured ? (
          <Text style={{ color: theme.color.accent, fontSize: 16 }}>Connect</Text>
        ) : null}
      </Pressable>
      {state.error ? (
        <Text
          style={{
            color: theme.color.danger,
            fontSize: 13,
            paddingHorizontal: SETTINGS_INSET,
            paddingBottom: 12,
          }}
        >
          {state.error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: SETTINGS_INSET,
    paddingVertical: 14,
  },
  lead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flexShrink: 1,
  },
  trail: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
    maxWidth: "55%",
  },
});
