import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SymbolView } from "expo-symbols";
import { useFocusEffect, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import * as WebBrowser from "expo-web-browser";
import {
  api,
  errorMessage,
  useAuth,
  type LastFMStatus,
} from "@music-library/core";
import {
  useBottomDockInset,
  useDockScrollHandler,
} from "../../../components/dock/dock-context";
import { OtaUpdateRows } from "../../../components/ota-updates";
import { Card, SectionLabel } from "../../../components/primitives";
import { useTheme, useThemeMode, type ThemeMode, type ThemeTokens } from "../../../theme/theme";
import { diagnosticsLog } from "../../../lib/diagnostics/log";
import { offlineStore, useOfflineForced } from "../../../lib/offline-mode";

export default function SettingsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const dockInset = useBottomDockInset();
  const dockScroll = useDockScrollHandler();
  const { me, logout } = useAuth();
  const { mode, setMode } = useThemeMode();
  const [signingOut, setSigningOut] = useState(false);
  const [lastFM, setLastFM] = useState<LastFMStatus | null>(null);
  const [lastFMBusy, setLastFMBusy] = useState(false);
  const [lastFMError, setLastFMError] = useState<string | null>(null);
  const [logProblems, setLogProblems] = useState(0);

  // Counting scans the log file, so it happens after paint rather than during
  // render. Re-counted on focus so the badge reflects a sync that just ran.
  useFocusEffect(
    useCallback(() => {
      const timer = setTimeout(
        () => setLogProblems(diagnosticsLog.problemCount()),
        0,
      );
      return () => clearTimeout(timer);
    }, []),
  );

  useEffect(() => {
    let cancelled = false;
    void api
      .getLastFMStatus()
      .then((status) => {
        if (!cancelled) setLastFM(status);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!lastFM?.configured || lastFM.connected || !lastFM.pending) return;
    const controller = new AbortController();
    setLastFMError(null);
    void api
      .waitForLastFMAuthorization({ signal: controller.signal })
      .then(({ username }) => {
        setLastFM((current) => ({
          configured: current?.configured ?? true,
          connected: true,
          pending: false,
          username,
        }));
      })
      .catch((error) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setLastFMError(
          errorMessage(error, "Could not complete Last.fm authorization."),
        );
      });
    return () => controller.abort();
  }, [lastFM?.configured, lastFM?.connected, lastFM?.pending]);

  const connectLastFM = async () => {
    setLastFMBusy(true);
    setLastFMError(null);
    try {
      const { authorization_url } = await api.connectLastFM();
      setLastFM((current) =>
        current ? { ...current, pending: true, last_error: undefined } : current,
      );
      await WebBrowser.openBrowserAsync(authorization_url, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      });
    } catch (error) {
      setLastFMError(errorMessage(error, "Could not connect Last.fm."));
    } finally {
      setLastFMBusy(false);
    }
  };

  const disconnectLastFM = async () => {
    setLastFMBusy(true);
    setLastFMError(null);
    try {
      await api.disconnectLastFM();
      setLastFM((current) => ({
        configured: current?.configured ?? true,
        connected: false,
        pending: false,
      }));
    } catch (error) {
      setLastFMError(errorMessage(error, "Could not disconnect Last.fm."));
    } finally {
      setLastFMBusy(false);
    }
  };

  const onSignOut = async () => {
    setSigningOut(true);
    try {
      // `api.logout()` clears the backend session and the native cookie jar
      // drops the stale cookie on the next request. No manual cookie purge
      // needed (avoiding the native `@react-native-cookies/cookies` dep).
      await logout();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <ScrollView
      {...dockScroll}
      style={{ flex: 1, backgroundColor: theme.color.bg }}
      contentInsetAdjustmentBehavior="automatic"
      scrollIndicatorInsets={{ bottom: dockInset }}
      contentContainerStyle={{
        paddingTop: theme.space.md,
        paddingBottom: dockInset + theme.space.md,
        gap: theme.space.lg,
      }}
    >
      <Section title="Account" theme={theme}>
        <Row label="Signed in as" value={me?.username ?? "—"} theme={theme} />
        <Row label="Role" value={me?.role ?? "—"} theme={theme} />
      </Section>

      <Section title="Appearance" theme={theme}>
        <ModePicker mode={mode} setMode={setMode} theme={theme} />
      </Section>

      <Section title="Offline" theme={theme}>
        <OfflineModeRow theme={theme} />
        <LinkRow
          label="Download log"
          icon="doc.text.magnifyingglass"
          theme={theme}
          firstBorder
          value={logProblems > 0 ? `${logProblems}` : undefined}
          valueTone={logProblems > 0 ? "danger" : undefined}
          onPress={() => {
            void Haptics.selectionAsync();
            router.push("/(tabs)/(settings)/download-log");
          }}
        />
      </Section>

      <Section title="Library" theme={theme}>
        <LinkRow
          label="Replay"
          icon="sparkles"
          theme={theme}
          onPress={() => {
            void Haptics.selectionAsync();
            router.push("/(tabs)/(settings)/replay");
          }}
        />
      </Section>

      <Section title="Connections" theme={theme}>
        <Pressable
          onPress={() => {
            void Haptics.selectionAsync();
            if (lastFM?.connected) void disconnectLastFM();
            else if (lastFM?.configured) void connectLastFM();
          }}
          disabled={lastFMBusy || !lastFM?.configured}
          style={({ pressed }) => [
            styles.row,
            {
              paddingHorizontal: theme.space.md,
              paddingVertical: 13,
              backgroundColor: pressed ? theme.color.bgElev2 : "transparent",
              opacity: lastFMBusy ? 0.65 : 1,
            },
          ]}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <SymbolView name="waveform.path" size={18} tintColor={theme.color.fg} />
            <View style={{ gap: 2 }}>
              <Text style={{ color: theme.color.fg, fontSize: 16 }}>Last.fm</Text>
              <Text style={{ color: theme.color.fgMuted, fontSize: 13 }}>
                {!lastFM
                  ? "Checking availability…"
                  : !lastFM.configured
                    ? "Server integration is not configured"
                    : lastFM.connected
                      ? `Scrobbling as ${lastFM.username || "connected user"}`
                      : lastFM.pending
                        ? "Tap to authorize again"
                        : "Connect your account to scrobble"}
              </Text>
            </View>
          </View>
          {lastFMBusy ? (
            <ActivityIndicator color={theme.color.fgMuted} />
          ) : (
            <Text style={{ color: lastFM?.connected ? theme.color.danger : theme.color.accent }}>
              {lastFM?.connected ? "Disconnect" : "Connect"}
            </Text>
          )}
        </Pressable>
        {(lastFMError || lastFM?.last_error) ? (
          <Text
            style={{
              color: theme.color.danger,
              fontSize: 13,
              paddingHorizontal: theme.space.md,
              paddingBottom: 12,
            }}
          >
            {lastFMError || lastFM?.last_error}
          </Text>
        ) : null}
      </Section>

      {me?.role === "admin" ? (
        <Section title="Admin" theme={theme}>
          <LinkRow
            label="Invitations"
            icon="envelope"
            theme={theme}
            onPress={() => {
              void Haptics.selectionAsync();
              router.push("/(tabs)/(settings)/admin-invites");
            }}
          />
          <LinkRow
            label="Library"
            icon="externaldrive"
            theme={theme}
            firstBorder
            onPress={() => {
              void Haptics.selectionAsync();
              router.push("/(tabs)/(settings)/admin-library");
            }}
          />
        </Section>
      ) : null}

      <Section title="Updates" theme={theme}>
        <OtaUpdateRows />
      </Section>

      <View style={{ paddingHorizontal: theme.space.lg }}>
        <Pressable
          onPress={onSignOut}
          disabled={signingOut}
          style={({ pressed }) => ({
            backgroundColor: theme.color.bgElev1,
            borderRadius: theme.radius.md,
            paddingVertical: 14,
            alignItems: "center",
            opacity: pressed ? 0.8 : 1,
            borderCurve: "continuous",
          })}
        >
          {signingOut ? (
            <ActivityIndicator color={theme.color.fgMuted} />
          ) : (
            <Text
              style={{ color: theme.color.danger, fontSize: 17, fontWeight: "500" }}
            >
              Sign out
            </Text>
          )}
        </Pressable>
      </View>
    </ScrollView>
  );
}

function Section({
  title,
  children,
  theme,
}: {
  title: string;
  children: React.ReactNode;
  theme: ThemeTokens;
}) {
  return (
    <View>
      <SectionLabel
        style={{
          fontSize: 13,
          paddingHorizontal: theme.space.lg,
          paddingBottom: theme.space.sm,
        }}
      >
        {title}
      </SectionLabel>
      <Card style={{ marginHorizontal: theme.space.lg, overflow: "hidden" }}>
        {children}
      </Card>
    </View>
  );
}

function OfflineModeRow({ theme }: { theme: ThemeTokens }) {
  const forced = useOfflineForced();
  return (
    <View style={{ paddingHorizontal: theme.space.md, paddingVertical: 12 }}>
      <View style={styles.row}>
        <Text style={{ color: theme.color.fg, fontSize: 16 }}>
          Offline mode
        </Text>
        <Switch
          value={forced}
          onValueChange={(value) => {
            void Haptics.selectionAsync();
            offlineStore.setForced(value);
          }}
          trackColor={{ true: theme.color.accent }}
          accessibilityLabel="Offline mode"
        />
      </View>
      <Text
        style={{
          color: theme.color.fgMuted,
          fontSize: 13,
          paddingTop: theme.space.sm,
        }}
      >
        Only downloaded music plays. No network is used until you turn this
        off.
      </Text>
    </View>
  );
}

function Row({
  label,
  value,
  theme,
}: {
  label: string;
  value: string;
  theme: ThemeTokens;
}) {
  return (
    <View
      style={[
        styles.row,
        { paddingHorizontal: theme.space.md, paddingVertical: 12 },
      ]}
    >
      <Text style={{ color: theme.color.fg, fontSize: 16 }}>{label}</Text>
      <Text style={{ color: theme.color.fgMuted, fontSize: 16 }}>{value}</Text>
    </View>
  );
}

function LinkRow({
  label,
  icon,
  onPress,
  theme,
  firstBorder,
  value,
  valueTone,
}: {
  label: string;
  icon: Parameters<typeof SymbolView>[0]["name"];
  onPress: () => void;
  theme: ThemeTokens;
  firstBorder?: boolean;
  /** Optional trailing detail shown before the chevron (a count, a status). */
  value?: string;
  valueTone?: "danger";
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          paddingHorizontal: theme.space.md,
          paddingVertical: 14,
          borderTopWidth: firstBorder ? StyleSheet.hairlineWidth : 0,
          borderTopColor: theme.color.separator,
          backgroundColor: pressed ? theme.color.bgElev2 : "transparent",
        },
      ]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <SymbolView name={icon} size={18} tintColor={theme.color.fg} />
        <Text style={{ color: theme.color.fg, fontSize: 16 }}>{label}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {value ? (
          <Text
            style={{
              color:
                valueTone === "danger"
                  ? theme.color.danger
                  : theme.color.fgMuted,
              fontSize: 16,
            }}
          >
            {value}
          </Text>
        ) : null}
        <SymbolView
          name="chevron.right"
          size={14}
          tintColor={theme.color.fgMuted}
        />
      </View>
    </Pressable>
  );
}

function ModePicker({
  mode,
  setMode,
  theme,
}: {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  theme: ThemeTokens;
}) {
  const options: { label: string; value: ThemeMode }[] = [
    { label: "System", value: "system" },
    { label: "Light", value: "light" },
    { label: "Dark", value: "dark" },
  ];
  return (
    <View>
      {options.map((opt, i) => (
        <Pressable
          key={opt.value}
          onPress={() => setMode(opt.value)}
          style={({ pressed }) => [
            styles.row,
            {
              paddingHorizontal: theme.space.md,
              paddingVertical: 12,
              borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
              borderTopColor: theme.color.separator,
              backgroundColor: pressed ? theme.color.bgElev2 : "transparent",
            },
          ]}
        >
          <Text style={{ color: theme.color.fg, fontSize: 16 }}>
            {opt.label}
          </Text>
          {mode === opt.value ? (
            <Text style={{ color: theme.color.accent, fontSize: 16 }}>✓</Text>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
});
