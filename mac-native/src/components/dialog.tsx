import { useEffect, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { AppText } from './primitives';
import { onEscape } from '../native/menu-commands';
import { useTheme } from '../theme/theme';

/**
 * A modal panel over the content pane, in the shape of an AppKit alert: title,
 * body, then a right-aligned button row.
 *
 * Not `Modal` from react-native — it has no macOS implementation — and
 * deliberately not a real `NSAlert`/sheet either: those cannot host React
 * content, and the fields inside these panels are the app's own.
 *
 * Dismissal follows the platform: Escape, or a click on the dimmed backdrop.
 */
export function Dialog({
  open,
  title,
  detail,
  onClose,
  children,
  actions,
}: {
  open: boolean;
  title: string;
  detail?: string;
  onClose: () => void;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const t = useTheme();

  useEffect(() => {
    if (!open) return;
    const subscription = onEscape(onClose);
    return () => subscription.remove();
  }, [open, onClose]);

  if (!open) return null;

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable
        style={[StyleSheet.absoluteFill, styles.scrim]}
        onPress={onClose}
        // The backdrop is a dismiss target, not a control worth announcing.
        accessibilityElementsHidden
      />
      <View style={styles.center} pointerEvents="box-none">
        <View
          style={[
            styles.panel,
            {
              backgroundColor: t.color.bgElev1,
              borderColor: t.color.separator,
              borderRadius: t.radius.lg,
              padding: t.space.xl,
              gap: t.space.md,
            },
          ]}>
          <View style={styles.heading}>
            <AppText variant="heading">{title}</AppText>
            {detail ? (
              <AppText variant="caption" muted>
                {detail}
              </AppText>
            ) : null}
          </View>
          {children}
          {actions ? (
            <View style={[styles.actions, { gap: t.space.sm, paddingTop: t.space.xs }]}>
              {actions}
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: 'rgba(0,0,0,0.35)' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  panel: {
    width: 380,
    borderWidth: StyleSheet.hairlineWidth,
    // A floating panel needs to read as lifted off the pane behind it.
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
  },
  heading: { gap: 2 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end' },
});
