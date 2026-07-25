import { requireNativeComponent, type ViewProps } from 'react-native';
import type { ReactNode } from 'react';

/**
 * AppKit vibrancy materials. Names match `NSVisualEffectView.Material`; the
 * ones the app actually uses are `sidebar` (navigation), `hudWindow` (floating
 * dock), `underWindowBackground` (window fill) and `popover` (overlays).
 */
export type VisualEffectMaterial =
  | 'titlebar'
  | 'selection'
  | 'menu'
  | 'popover'
  | 'sidebar'
  | 'headerView'
  | 'sheet'
  | 'windowBackground'
  | 'hudWindow'
  | 'fullScreenUI'
  | 'toolTip'
  | 'contentBackground'
  | 'underWindowBackground'
  | 'underPageBackground';

interface NativeProps extends ViewProps {
  materialName?: VisualEffectMaterial;
  blendingModeName?: 'behindWindow' | 'withinWindow';
  cornerRadius?: number;
  alwaysActive?: boolean;
  fadeBottom?: number;
  children?: ReactNode;
}

const NativeVisualEffectView =
  requireNativeComponent<NativeProps>('LMVisualEffectView');

export interface VisualEffectViewProps extends ViewProps {
  material?: VisualEffectMaterial;
  /**
   * `behindWindow` samples the desktop behind the window (what a sidebar
   * does); `withinWindow` samples the app's own content underneath, which is
   * what a dock floating over a scrolling list needs.
   */
  blendingMode?: 'behindWindow' | 'withinWindow';
  cornerRadius?: number;
  /** Keep the material at full strength even when the window is not key. */
  alwaysActive?: boolean;
  /**
   * Fade the material to transparent over this many points at its bottom
   * edge — the scroll-edge look, where content dissolves into the header
   * rather than being clipped by it.
   */
  fadeBottom?: number;
  children?: ReactNode;
}

export function VisualEffectView({
  material = 'sidebar',
  blendingMode = 'behindWindow',
  cornerRadius = 0,
  alwaysActive = false,
  fadeBottom = 0,
  ...rest
}: VisualEffectViewProps) {
  return (
    <NativeVisualEffectView
      materialName={material}
      blendingModeName={blendingMode}
      cornerRadius={cornerRadius}
      alwaysActive={alwaysActive}
      fadeBottom={fadeBottom}
      {...rest}
    />
  );
}
