import { useCallback, useState } from "react";
import { ScrollView, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useAuth } from "@music-library/core";
import {
  useBottomDockInset,
  useDockScrollHandler,
} from "../../../components/dock/dock-context";
import { OtaUpdateRows } from "../../../components/ota-updates";
import { AccountCard } from "../../../components/settings/account-card";
import { AppearanceTile } from "../../../components/settings/appearance-tile";
import { DeviceCard } from "../../../components/settings/device-card";
import { LastFmRow } from "../../../components/settings/lastfm-row";
import { ReplayRow, useReplayTeaser } from "../../../components/settings/replay-row";
import {
  SettingsCard,
  SettingsLinkRow,
  SettingsSectionLabel,
} from "../../../components/settings/settings-card";
import { SmoothMixTile } from "../../../components/settings/smooth-mix-tile";
import { useTheme } from "../../../theme/theme";
import { diagnosticsLog } from "../../../lib/diagnostics/log";

/**
 * Settings, you first: the account, then what you listen to (Replay,
 * Last.fm), then the sound (Smooth mix), this device (downloads, Offline
 * mode, the download log), the look, the server (admins), and last the build.
 * The live controls show what they do rather than describe it.
 */
export default function SettingsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const dockInset = useBottomDockInset();
  const dockScroll = useDockScrollHandler();
  const { me } = useAuth();
  const replay = useReplayTeaser();
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

  return (
    <ScrollView
      {...dockScroll}
      style={{ flex: 1, backgroundColor: theme.color.bg }}
      contentInsetAdjustmentBehavior="automatic"
      scrollIndicatorInsets={{ bottom: dockInset }}
      contentContainerStyle={{
        paddingTop: theme.space.sm,
        paddingBottom: dockInset + theme.space.md,
        gap: theme.space.lg + theme.space.xs,
      }}
    >
      <AccountCard />

      <SettingsCard>
        <ReplayRow
          teaser={replay}
          onPress={() => router.push("/(tabs)/(settings)/replay")}
        />
        <LastFmRow border />
      </SettingsCard>

      <SmoothMixTile />

      <DeviceCard
        logProblems={logProblems}
        onOpenLog={() => router.push("/(tabs)/(settings)/download-log")}
      />

      <AppearanceTile covers={replay.covers} />

      {me?.role === "admin" ? (
        <View>
          <SettingsSectionLabel>Server</SettingsSectionLabel>
          <SettingsCard>
            <SettingsLinkRow
              label="Invitations"
              icon="envelope"
              onPress={() => router.push("/(tabs)/(settings)/admin-invites")}
            />
            <SettingsLinkRow
              label="Library"
              icon="externaldrive"
              border
              onPress={() => router.push("/(tabs)/(settings)/admin-library")}
            />
            <SettingsLinkRow
              label="TIDAL"
              icon="waveform"
              border
              onPress={() => router.push("/(tabs)/(settings)/admin-tidal")}
            />
          </SettingsCard>
        </View>
      ) : null}

      <SettingsCard>
        <OtaUpdateRows />
      </SettingsCard>
    </ScrollView>
  );
}
