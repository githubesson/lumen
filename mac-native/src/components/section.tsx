import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SFSymbol } from '../native/sf-symbol';
import { AppText } from './primitives';
import { useHover } from './hoverable';
import { useTheme } from '../theme/theme';

/**
 * Section shell for the scrolling home page: an eyebrow and title on the left,
 * an optional action on the right, then the body. Horizontal padding is on the
 * header only, so a full-bleed shelf can run its own edge insets and scroll
 * past them.
 */
export function Section({
  eyebrow,
  title,
  actionLabel,
  actionSymbol,
  onAction,
  children,
}: {
  eyebrow?: string;
  title: string;
  actionLabel?: string;
  actionSymbol?: string;
  onAction?: () => void;
  children: ReactNode;
}) {
  const t = useTheme();
  return (
    <View style={{ gap: t.space.sm }}>
      <View style={[styles.header, { paddingHorizontal: t.space.xl }]}>
        <View style={styles.headerText}>
          {eyebrow ? (
            <AppText variant="caption" muted style={styles.eyebrow}>
              {eyebrow.toUpperCase()}
            </AppText>
          ) : null}
          <AppText variant="heading" style={styles.title} numberOfLines={1}>
            {title}
          </AppText>
        </View>
        {actionLabel && onAction ? (
          <SectionAction label={actionLabel} symbol={actionSymbol} onPress={onAction} />
        ) : null}
      </View>
      {children}
    </View>
  );
}

function SectionAction({
  label,
  symbol,
  onPress,
}: {
  label: string;
  symbol?: string;
  onPress: () => void;
}) {
  const t = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.action,
        {
          gap: 5,
          borderRadius: t.radius.sm,
          backgroundColor: hovered ? t.color.hover : 'transparent',
        },
      ]}
      {...hoverProps}>
      {symbol ? <SFSymbol name={symbol} size={11} color={t.color.accent} /> : null}
      <AppText variant="label" style={{ color: t.color.accent }}>
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
  headerText: { flex: 1, minWidth: 0, gap: 1 },
  eyebrow: { letterSpacing: 0.6, fontWeight: '600' },
  title: { fontSize: 17 },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 24,
    paddingHorizontal: 8,
  },
});
