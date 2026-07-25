import { requireNativeComponent, type ViewProps } from 'react-native';
import type { ReactNode } from 'react';

interface NativeProps extends ViewProps {
  cornerRadius?: number;
  glassStyle?: 'regular' | 'clear';
  tintColor?: string;
  children?: ReactNode;
}

const NativeGlassEffectView =
  requireNativeComponent<NativeProps>('LMGlassEffectView');

export interface GlassEffectViewProps extends ViewProps {
  /** `regular` for chrome, `clear` for large panels over artwork. */
  variant?: 'regular' | 'clear';
  cornerRadius?: number;
  tint?: string;
  children?: ReactNode;
}

/**
 * Liquid Glass (macOS 26 `NSGlassEffectView`), with a vibrancy fallback on
 * older systems. Use for anything that floats above content — the dock and the
 * Now Playing panel — so it matches the system's own floating chrome.
 */
export function GlassEffectView({
  variant = 'regular',
  cornerRadius = 0,
  tint,
  ...rest
}: GlassEffectViewProps) {
  return (
    <NativeGlassEffectView
      glassStyle={variant}
      cornerRadius={cornerRadius}
      tintColor={tint}
      {...rest}
    />
  );
}
