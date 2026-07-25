import { requireNativeComponent, type ViewProps } from 'react-native';

export type SymbolWeight =
  | 'ultraLight'
  | 'thin'
  | 'light'
  | 'regular'
  | 'medium'
  | 'semibold'
  | 'bold'
  | 'heavy'
  | 'black';

interface NativeProps extends ViewProps {
  symbolName?: string;
  pointSize?: number;
  weightName?: SymbolWeight;
  tintColor?: number | string;
}

const NativeSFSymbol = requireNativeComponent<NativeProps>('LMSFSymbolView');

export interface SFSymbolProps extends Omit<ViewProps, 'children'> {
  /** SF Symbol name — the same names the iOS client uses with expo-symbols. */
  name: string;
  size?: number;
  weight?: SymbolWeight;
  color?: string;
}

/**
 * An SF Symbol rendered by AppKit. Sized explicitly rather than by intrinsic
 * content size so rows and buttons lay out identically whether or not the
 * symbol resolves on this macOS version.
 */
export function SFSymbol({
  name,
  size = 15,
  weight = 'regular',
  color,
  style,
  ...rest
}: SFSymbolProps) {
  return (
    <NativeSFSymbol
      symbolName={name}
      pointSize={size}
      weightName={weight}
      tintColor={color}
      style={[{ width: size * 1.4, height: size * 1.4 }, style]}
      {...rest}
    />
  );
}
