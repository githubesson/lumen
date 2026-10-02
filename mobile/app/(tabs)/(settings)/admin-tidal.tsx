import { type ComponentProps } from "react";
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
  tidalAutoDownloadProblems,
  tidalStatusDetails,
  tidalStatusErrors,
  useTidalDeviceLogin,
  type TidalAccount,
  type TidalAutoDownloadStatus,
} from "@music-library/core";
import { HeaderIconButton } from "../../../components/header-buttons";
import { Card, SectionLabel } from "../../../components/primitives";
import { qk } from "../../../lib/query-keys";
import { useTheme, type ThemeTokens } from "../../../theme/theme";

export default function AdminTidalScreen() {
  const theme = useTheme();
  const queryClient = useQueryClient();

  const statusQuery = useQuery({
    queryKey: qk.adminTidalStatus,
    queryFn: ({ signal }) => api.tidalStatus({ signal }),
    staleTime: 0,
  });

  const {
    flow,
    starting,
    unlinkingId,
    error: loginError,
    notice: message,
    start,
    reopen,
    unlink,
  } = useTidalDeviceLogin({
    // Resolves when the sheet is dismissed; the login is polled meanwhile.
    openVerification: async (url) => {
      await WebBrowser.openBrowserAsync(url, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      });
    },
    onLinked: () => void WebBrowser.dismissBrowser().catch(() => {}),
    onAccountsChanged: () =>
      queryClient.invalidateQueries({ queryKey: qk.adminTidalStatus }),
  });

  const autoDownloadQuery = useQuery({
    queryKey: qk.adminTidalAutoDownload,
    queryFn: ({ signal }) => api.tidalAutoDownload({ signal }),
    staleTime: 0,
  });
  const retryDownloads = useMutation({
    mutationFn: () => api.retryTidalAutoDownloads(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: qk.adminTidalAutoDownload }),
    onError: (error) =>
      Alert.alert(
        "Couldn't retry downloads",
        errorMessage(error, "Please try again."),
      ),
  });

  const onStartAuth = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    void start();
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
          onPress: () => void unlink(account),
        },
      ],
    );
  };

  const status = statusQuery.data;
  const accounts = status?.accounts ?? [];
  const details = tidalStatusDetails(status);
  const errors = tidalStatusErrors(
    loginError ??
      (statusQuery.error
        ? errorMessage(statusQuery.error, "Could not load TIDAL status.")
        : null),
    status,
  );

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
                void autoDownloadQuery.refetch();
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
          country={details.country}
          quality={details.quality}
          version={details.version}
          theme={theme}
        />

        {errors.length > 0 ? (
          <Card style={{ padding: theme.space.md, gap: theme.space.sm }}>
            {errors.map((error) => (
              <Text
                key={error}
                selectable
                style={{ color: theme.color.danger, fontSize: 13 }}
              >
                {error}
              </Text>
            ))}
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
              removing={unlinkingId === account.id}
              disabled={unlinkingId !== null}
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
              onPress={() => void reopen()}
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
          label={starting ? "Starting sign-in…" : "Link TIDAL account"}
          icon="person.badge.plus"
          loading={starting}
          disabled={
            starting ||
            unlinkingId !== null ||
            !!flow ||
            !status?.connected ||
            !status?.management_supported
          }
          onPress={onStartAuth}
          theme={theme}
          primary
        />

        {autoDownloadQuery.data ? (
          <AutoDownloadSection
            status={autoDownloadQuery.data}
            retrying={retryDownloads.isPending}
            onRetry={() => {
              void Haptics.selectionAsync();
              retryDownloads.mutate();
            }}
            theme={theme}
          />
        ) : null}
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

function AutoDownloadSection({
  status,
  retrying,
  onRetry,
  theme,
}: {
  status: TidalAutoDownloadStatus;
  retrying: boolean;
  onRetry: () => void;
  theme: ThemeTokens;
}) {
  const { summary } = status;
  const problems = tidalAutoDownloadProblems(status);
  return (
    <View style={{ gap: theme.space.sm }}>
      <SectionLabel>Server library saving</SectionLabel>
      <Card style={{ padding: theme.space.lg, gap: theme.space.md }}>
        <Text selectable style={{ color: theme.color.fgMuted, fontSize: 13, lineHeight: 18 }}>
          Turn it on from a playlist&apos;s menu. Its TIDAL tracks are saved to{" "}
          {status.destination ?? "the music folder"} and the playlist switches
          to the library copies. Change the folder from the web admin.
        </Text>
        {problems.map((problem) => (
          <Text
            key={problem}
            selectable
            style={{ color: theme.color.danger, fontSize: 13 }}
          >
            {problem}
          </Text>
        ))}
        <View style={{ flexDirection: "row", gap: theme.space.sm }}>
          <StatusValue label="Playlists" value={String(summary.playlists)} theme={theme} />
          <StatusValue label="Queued" value={String(summary.queued)} theme={theme} />
          <StatusValue label="Failed" value={String(summary.failed)} theme={theme} />
          <StatusValue label="Saved" value={String(summary.saved)} theme={theme} />
        </View>
        {summary.failed > 0 ? (
          <ActionButton
            label={retrying ? "Retrying…" : "Retry failed downloads"}
            icon="arrow.clockwise"
            loading={retrying}
            disabled={retrying}
            onPress={onRetry}
            theme={theme}
          />
        ) : null}
      </Card>
    </View>
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
