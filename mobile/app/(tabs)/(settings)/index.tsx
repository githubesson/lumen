import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SymbolView } from "expo-symbols";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { useAuth } from "@music-library/core";
import {
  useBottomDockInset,
  useDockScrollHandler,
} from "../../../components/dock/dock-context";
import { Card, SectionLabel } from "../../../components/primitives";
import { useTheme, useThemeMode, type ThemeMode, type ThemeTokens } from "../../../theme/theme";

export default function SettingsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const dockInset = useBottomDockInset();
  const dockScroll = useDockScrollHandler();
  const { me, logout } = useAuth();
  const { mode, setMode } = useThemeMode();
  const [signingOut, setSigningOut] = useState(false);

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
}: {
  label: string;
  icon: Parameters<typeof SymbolView>[0]["name"];
  onPress: () => void;
  theme: ThemeTokens;
  firstBorder?: boolean;
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
      <SymbolView
        name="chevron.right"
        size={14}
        tintColor={theme.color.fgMuted}
      />
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
