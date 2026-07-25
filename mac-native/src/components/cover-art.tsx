import { useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { SFSymbol } from '../native/sf-symbol';
import { useTheme } from '../theme/theme';

/**
 * Album/track artwork with a symbol placeholder. Failed and missing artwork
 * render the same neutral tile so a grid never shows a torn image.
 */
export function CoverArt({
  url,
  size,
  radius,
}: {
  url?: string | null;
  size: number;
  radius?: number;
}) {
  const t = useTheme();
  const [failed, setFailed] = useState(false);
  const cornerRadius = radius ?? t.radius.sm;

  const box = {
    width: size,
    height: size,
    borderRadius: cornerRadius,
    backgroundColor: t.color.bgElev2,
  };

  if (!url || failed) {
    return (
      <View style={[box, styles.placeholder]}>
        <SFSymbol
          name="music.note"
          size={Math.max(10, size * 0.32)}
          color={t.color.fgMuted}
        />
      </View>
    );
  }

  return (
    <Image
      source={{ uri: url }}
      style={box}
      onError={() => setFailed(true)}
      resizeMode="cover"
    />
  );
}

const styles = StyleSheet.create({
  placeholder: { alignItems: 'center', justifyContent: 'center' },
});
