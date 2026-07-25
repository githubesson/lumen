import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { VisualEffectView } from '../../native/visual-effect-view';
import { AppText } from '../../components/primitives';
import { useTheme } from '../../theme/theme';

/**
 * Shared chrome for the pre-session screens: a vibrancy backdrop the whole
 * window can be dragged by (there is no visible titlebar to grab) with a narrow
 * centred column of controls.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const t = useTheme();
  return (
    <VisualEffectView
      material="underWindowBackground"
      blendingMode="behindWindow"
      style={styles.backdrop}
      mouseDownCanMoveWindow>
      <View style={[styles.column, { gap: t.space.xl }]}>
        <View style={{ gap: t.space.xs }}>
          <AppText variant="title">{title}</AppText>
          {subtitle ? <AppText muted>{subtitle}</AppText> : null}
        </View>
        <View style={{ gap: t.space.md }}>{children}</View>
        {footer ? <View style={{ gap: t.space.sm }}>{footer}</View> : null}
      </View>
    </VisualEffectView>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  column: { width: 340 },
});
