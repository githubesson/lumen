import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { VisualEffectView } from '../native/visual-effect-view';
import { AppText } from './primitives';
import { useTheme } from '../theme/theme';

/**
 * Height of the window's unified toolbar. Content runs underneath it so the
 * toolbar's glass has something to tint against. Back navigation lives up
 * there too, as a native toolbar item (`LMToolbar`), not in the screen.
 */
export const TOOLBAR_INSET = 52;

/** Title line plus the padding under it. */
const TITLE_BLOCK = 46;

/** How far past the title block the header's blur fades out. */
const FADE = 30;

/** Full height of the floating header, fade zone included. */
const HEADER_TOTAL = TOOLBAR_INSET + TITLE_BLOCK + FADE;

/**
 * Scroll inset for content under the floating header. It reaches a few points
 * into the fade zone, so a resting list starts just under the title and rows
 * dissolve into the fade as they scroll up — the inset is scrollable space,
 * not a gap.
 */
export const HEADER_HEIGHT = TOOLBAR_INSET + TITLE_BLOCK + 6;

/**
 * Standard content-pane layout: children fill the pane, and a large title
 * floats over them on a scroll-edge blur — a `withinWindow` material that is
 * full strength behind the title and fades to nothing below it, so rows
 * scrolling out of view are seen dissolving into the header rather than being
 * clipped by a hard edge or a visible band.
 *
 * Children keep their first row clear of the header by passing
 * {@link HEADER_HEIGHT} as their top inset (lists) or top padding (static
 * content).
 *
 * With no `title`, the screen is a hero page: the name lives in the content
 * (next to cover art, like a playlist), so there is no floating title and the
 * screen is just its content — which is then responsible for clearing the
 * toolbar with {@link TOOLBAR_INSET}.
 */
export function Screen({
  title,
  subtitle,
  accessory,
  overlay,
  children,
}: {
  title?: string;
  subtitle?: string;
  accessory?: ReactNode;
  /** Drawn above the header — dialogs, which must cover the whole pane. */
  overlay?: ReactNode;
  children: ReactNode;
}) {
  const t = useTheme();

  if (title == null) {
    return (
      <View style={styles.root}>
        <View style={styles.body}>{children}</View>
        {overlay}
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.body}>{children}</View>

      <View style={styles.header} pointerEvents="box-none">
        <VisualEffectView
          material="sidebar"
          blendingMode="withinWindow"
          fadeBottom={FADE}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <View
          style={[
            styles.titleRow,
            {
              paddingHorizontal: t.space.xl,
              gap: t.space.sm,
            },
          ]}
          pointerEvents="box-none">
          <View style={styles.headerText}>
            <AppText variant="heading" numberOfLines={1} style={styles.title}>
              {title}
            </AppText>
            {subtitle ? (
              <AppText variant="caption" muted numberOfLines={1}>
                {subtitle}
              </AppText>
            ) : null}
          </View>
          {accessory}
        </View>
      </View>

      {overlay}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1 },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: HEADER_TOTAL,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: TOOLBAR_INSET,
  },
  headerText: { flex: 1, minWidth: 0 },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.4 },
});
