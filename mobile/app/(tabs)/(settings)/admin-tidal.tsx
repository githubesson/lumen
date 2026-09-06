import { useEffect, useState, type ComponentProps } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import * as WebBrowser from "expo-web-browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  errorMessage,
  type TidalAccount,
  type TidalAuthStart,
} from "@music-library/core";
import { HeaderIconButton } from "../../../components/header-buttons";
import { Card, SectionLabel } from "../../../components/primitives";
import { qk } from "../../../lib/query-keys";
import { useTheme, type ThemeTokens } from "../../../theme/theme";

export default function AdminTidalScreen() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [flow, setFlow] = useState<TidalAuthStart | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: qk.adminTidalStatus,
    queryFn: ({ signal }) => api.tidalStatus({ signal }),
    staleTime: 0,
  });

  useEffect(() => {
    if (!flow) return;
    const controller = new AbortController();
    const expiresIn = Date.parse(flow.expires_at) - Date.now();
    void api
      .waitForTidalAuthorization(flow.flow_id, {
        signal: controller.signal,
        timeoutMs: Number.isFinite(expiresIn)
          ? Math.max(2500, expiresIn + 5000)
          : undefined,
      })
      .then((result) => {
        setFlow(null);
        if (result.state === "linked") {
          void WebBrowser.dismissBrowser().catch(() => {});
          setMessage(
            result.account?.user_id
              ? `TIDAL account ${result.account.user_id} linked.`
              : "TIDAL account linked.",
          );
          setLocalError(null);
          void queryClient.invalidateQueries({ queryKey: qk.adminTidalStatus });
          return;
        }
        setLocalError(result.message || `TIDAL sign-in ${result.state}.`);
      })
      .catch((error) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setFlow(null);
        setLocalError(
          errorMessage(error, "Could not complete TIDAL sign-in."),
        );
      });
    return () => controller.abort();
  }, [flow, queryClient]);

  const startAuth = useMutation({
    mutationFn: () => api.startTidalAuth(),
  });

  const removeAccount = useMutation({
    mutationFn: (account: TidalAccount) => api.removeTidalAccount(account.id),
    onSuccess: () => {
      setMessage("TIDAL account unlinked.");
      setLocalError(null);
      void queryClient.invalidateQueries({ queryKey: qk.adminTidalStatus });
    },
    onError: (error) =>
      setLocalError(errorMessage(error, "Could not unlink the TIDAL account.")),
  });

  const onStartAuth = async () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setMessage(null);
    setLocalError(null);
    try {
      const started = await startAuth.mutateAsync();
      setFlow(started);
      await WebBrowser.openBrowserAsync(started.verification_url, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      });
    } catch (error) {
      setLocalError(errorMessage(error, "Could not start TIDAL sign-in."));
    }
  };

  const openFlow = async () => {
    if (!flow) return;
    try {
      await WebBrowser.openBrowserAsync(flow.verification_url, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      });
    } catch {
      setLocalError("Could not open the TIDAL sign-in page.");
    }
  };

  const confirmRemove = (account: TidalAccount) => {
    Alert.alert(
      "Unlink TIDAL account?",
      `Account ${account.user_id || account.id} will stop being used for TIDAL playback.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Unlink",
          style: "destructive",
          onPress: () => removeAccount.mutate(account),
        },
      ],
    );
  };

  const status = statusQuery.data;
  const accounts = status?.accounts ?? [];
  const error =
    localError ||
    (statusQuery.error
      ? errorMessage(statusQuery.error, "Could not load TIDAL status.")
      : status?.management_error || status?.error);

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <HeaderIconButton
              icon="arrow.clockwise"
              label="Refresh TIDAL status"
              disabled={statusQuery.isFetching}
              onPress={() => {
                void Haptics.selectionAsync();
                void statusQuery.refetch();
              }}
            />
          ),
        }}
      />
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.color.bg }}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          padding: theme.space.lg,
          paddingBottom: theme.space.xl * 2,
          gap: theme.space.lg,
        }}
      >
        <StatusCard
          connected={!!status?.connected}
          loading={statusQuery.isLoading}
          country={status?.country_code || "US"}
          quality={status?.quality || "LOSSLESS"}
          version={status?.version || "unknown"}
          theme={theme}
        />

        {error ? (
          <Card style={{ padding: theme.space.md }}>
            <Text selectable style={{ color: theme.color.danger, fontSize: 13 }}>
              {error}
            </Text>
          </Card>
        ) : null}

        {message ? (
          <Card
            style={{
              padding: theme.space.md,
              flexDirection: "row",
              alignItems: "center",
              gap: theme.space.sm,
            }}
          >
            <SymbolView name="checkmark.circle.fill" size={20} tintColor={theme.color.success} />
            <Text selectable style={{ color: theme.color.fg, fontSize: 14, flex: 1 }}>
              {message}
            </Text>
          </Card>
        ) : null}

        <View style={{ gap: theme.space.sm }}>
          <SectionLabel>Linked accounts ({accounts.length})</SectionLabel>
          {accounts.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              removing={removeAccount.isPending && removeAccount.variables?.id === account.id}
              disabled={removeAccount.isPending}
              onRemove={() => confirmRemove(account)}
              theme={theme}
            />
          ))}
          {!statusQuery.isLoading && accounts.length === 0 ? (
            <Card style={{ padding: theme.space.lg, gap: theme.space.sm }}>
              <Text style={{ color: theme.color.fg, fontSize: 16, fontWeight: "600" }}>
                No account linked
              </Text>
              <Text selectable style={{ color: theme.color.fgMuted, fontSize: 13, lineHeight: 18 }}>
                Link a subscribed TIDAL account to enable full search and playback.
              </Text>
            </Card>
          ) : null}
        </View>

        {flow ? (
          <Card style={{ padding: theme.space.lg, gap: theme.space.md }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.sm }}>
              <ActivityIndicator color={theme.color.accent} />
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={{ color: theme.color.fg, fontSize: 16, fontWeight: "600" }}>
                  Waiting for TIDAL
                </Text>
                <Text style={{ color: theme.color.fgMuted, fontSize: 13 }}>
                  This page updates automatically after approval.
                </Text>
              </View>
            </View>
            {flow.user_code ? (
              <View style={{ gap: 4 }}>
                <SectionLabel>Code</SectionLabel>
                <Text
                  selectable
                  style={{
                    color: theme.color.fg,
                    fontSize: 22,
                    fontWeight: "600",
                    letterSpacing: 1.5,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {flow.user_code}
                </Text>
              </View>
            ) : null}
            <ActionButton
              label="Open TIDAL"
              icon="arrow.up.forward.app"
              onPress={() => void openFlow()}
              theme={theme}
            />
          </Card>
        ) : null}

        {!status?.management_supported && !statusQuery.isLoading ? (
          <Text selectable style={{ color: theme.color.fgMuted, fontSize: 12, lineHeight: 17 }}>
            Account controls require the Lumen hifi-api extension. Recreate the
            hifi-api container after updating the server.
          </Text>
        ) : null}

        <ActionButton
          label={startAuth.isPending ? "Starting sign-in…" : "Link TIDAL account"}
          icon="person.badge.plus"
          loading={startAuth.isPending}
          disabled={
            startAuth.isPending ||
            !!flow ||
            !status?.connected ||
            !status?.management_supported
          }
          onPress={() => void onStartAuth()}
          theme={theme}
          primary
        />
      </ScrollView>
    </>
  );
}

function StatusCard({
  connected,
  loading,
  country,
  quality,
  version,
  theme,
}: {
  connected: boolean;
  loading: boolean;
  country: string;
  quality: string;
  version: string;
  theme: ThemeTokens;
}) {
  return (
    <Card style={{ padding: theme.space.lg, gap: theme.space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.md }}>
        <View
          style={{
            width: 42,
            height: 42,
            borderRadius: 21,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.color.bgElev2,
          }}
        >
          {loading ? (
            <ActivityIndicator color={theme.color.fgMuted} />
          ) : (
            <SymbolView
              name={connected ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"}
              size={22}
              tintColor={connected ? theme.color.success : theme.color.danger}
            />
          )}
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={{ color: theme.color.fg, fontSize: 17, fontWeight: "600" }}>
            {loading ? "Checking proxy…" : connected ? "Proxy online" : "Proxy offline"}
          </Text>
          <Text style={{ color: theme.color.fgMuted, fontSize: 13 }}>
            TIDAL credentials stay on the server.
          </Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: theme.space.sm }}>
        <StatusValue label="Country" value={country} theme={theme} />
        <StatusValue label="Quality" value={quality} theme={theme} />
        <StatusValue label="Version" value={version} theme={theme} />
      </View>
    </Card>
  );
}

function StatusValue({
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
      style={{
        flex: 1,
        backgroundColor: theme.color.bgElev2,
        borderRadius: theme.radius.sm,
        borderCurve: "continuous",
        padding: theme.space.sm,
        gap: 3,
      }}
    >
      <Text style={{ color: theme.color.fgMuted, fontSize: 10, textTransform: "uppercase" }}>
        {label}
      </Text>
      <Text selectable numberOfLines={1} style={{ color: theme.color.fg, fontSize: 12 }}>
        {value}
      </Text>
    </View>
  );
}

function AccountCard({
  account,
  removing,
  disabled,
  onRemove,
  theme,
}: {
  account: TidalAccount;
  removing: boolean;
  disabled: boolean;
  onRemove: () => void;
  theme: ThemeTokens;
}) {
  return (
    <Card
      style={{
        padding: theme.space.md,
        flexDirection: "row",
        alignItems: "center",
        gap: theme.space.md,
      }}
    >
      <SymbolView name="person.crop.circle.fill" size={30} tintColor={theme.color.fgMuted} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text selectable style={{ color: theme.color.fg, fontSize: 15, fontWeight: "600" }}>
          Account {account.user_id || "unknown"}
        </Text>
        <Text style={{ color: theme.color.fgMuted, fontSize: 12 }}>
          {account.removable ? "Managed by Lumen" : "Configured by environment"}
        </Text>
      </View>
      {account.removable ? (
        <Pressable
          onPress={onRemove}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`Unlink TIDAL account ${account.user_id}`}
          hitSlop={10}
          style={({ pressed }) => ({ opacity: disabled ? 0.35 : pressed ? 0.55 : 1 })}
        >
          {removing ? (
            <ActivityIndicator color={theme.color.fgMuted} />
          ) : (
            <Text style={{ color: theme.color.danger, fontSize: 15 }}>Unlink</Text>
          )}
        </Pressable>
      ) : null}
    </Card>
  );
}

function ActionButton({
  label,
  icon,
  loading = false,
  disabled = false,
  primary = false,
  onPress,
  theme,
}: {
  label: string;
  icon: ComponentProps<typeof SymbolView>["name"];
  loading?: boolean;
  disabled?: boolean;
  primary?: boolean;
  onPress: () => void;
  theme: ThemeTokens;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        minHeight: 48,
        borderRadius: theme.radius.md,
        borderCurve: "continuous",
        backgroundColor: primary ? theme.color.accent : theme.color.bgElev2,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: theme.space.sm,
        opacity: disabled ? 0.4 : pressed ? 0.75 : 1,
      })}
    >
      {loading ? (
        <ActivityIndicator color={primary ? theme.color.onAccent : theme.color.fgMuted} />
      ) : (
        <SymbolView
          name={icon}
          size={18}
          tintColor={primary ? theme.color.onAccent : theme.color.fg}
        />
      )}
      <Text
        style={{
          color: primary ? theme.color.onAccent : theme.color.fg,
          fontSize: 16,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
