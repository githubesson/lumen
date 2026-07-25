import { ScrollView, StyleSheet, View } from 'react-native';
import { useAuth, getBaseUrl } from '@music-library/core';
import { HEADER_HEIGHT, Screen } from '../components/screen';
import { DOCK_CLEARANCE } from '../components/track-list';
import { Segmented } from '../components/segmented';
import { AppText, Button, Separator } from '../components/primitives';
import { useTheme, useThemeMode, type ThemeMode } from '../theme/theme';

function Row({
  label,
  detail,
  children,
}: {
  label: string;
  detail?: string;
  children?: React.ReactNode;
}) {
  const t = useTheme();
  return (
    <View style={[styles.row, { paddingVertical: t.space.md, gap: t.space.md }]}>
      <View style={styles.rowText}>
        <AppText variant="label">{label}</AppText>
        {detail ? (
          <AppText variant="caption" muted>
            {detail}
          </AppText>
        ) : null}
      </View>
      {children}
    </View>
  );
}

export function SettingsScreen({ onChangeServer }: { onChangeServer: () => void }) {
  const t = useTheme();
  const { me, logout } = useAuth();
  const { mode, setMode } = useThemeMode();

  return (
    <Screen title="Settings">
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: t.space.xl,
          paddingTop: HEADER_HEIGHT,
          paddingBottom: DOCK_CLEARANCE,
        }}>
        <Row label="Appearance" detail="Follow the system or pin a theme.">
          <Segmented<ThemeMode>
            value={mode}
            onChange={setMode}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </Row>
        <Separator />
        <Row label="Account" detail={me?.username} />
        <Separator />
        <Row label="Server" detail={getBaseUrl()}>
          <Button title="Change" onPress={onChangeServer} />
        </Row>
        <Separator />
        <Row label="Sign out" detail="End this session on that server.">
          <Button title="Sign out" variant="danger" onPress={() => void logout()} />
        </Row>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  rowText: { flex: 1, gap: 2 },
});
