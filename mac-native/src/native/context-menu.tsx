import {
  NativeModules,
  requireNativeComponent,
  type NativeSyntheticEvent,
  type ViewProps,
} from 'react-native';
import type { ReactNode } from 'react';

export interface ContextMenuItem {
  id?: string;
  title?: string;
  /** SF Symbol shown beside the title. */
  symbol?: string;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  /** Non-interactive section title, like SwiftUI's `Section` header. */
  header?: boolean;
  /** Red title and symbol — the destructive-action look. */
  destructive?: boolean;
  children?: ContextMenuItem[];
}

interface LMContextMenuNativeModule {
  show(
    items: ContextMenuItem[],
    position: { x: number; y: number },
  ): Promise<string | null>;
}

const nativeModule = NativeModules.LMContextMenuModule as
  | LMContextMenuNativeModule
  | undefined;

if (!nativeModule) {
  throw new Error(
    'LMContextMenuModule is missing. Run `pod install --project-directory=macos` and rebuild.',
  );
}

const ContextMenu: LMContextMenuNativeModule = nativeModule;

/**
 * Show a real AppKit menu at a window point and resolve with the chosen id, or
 * null if it was dismissed.
 */
export function showContextMenu(
  items: ContextMenuItem[],
  position: { x: number; y: number },
): Promise<string | null> {
  return ContextMenu.show(items, position);
}

export interface ContextMenuEvent {
  x: number;
  y: number;
  localX: number;
  localY: number;
}

interface NativeTargetProps extends ViewProps {
  onContextMenu?: (e: NativeSyntheticEvent<ContextMenuEvent>) => void;
  children?: ReactNode;
}

const NativeContextMenuTarget =
  requireNativeComponent<NativeTargetProps>('LMContextMenuTarget');

/** Wraps content so right-click (and control-click) reports a menu location. */
export function ContextMenuTarget({
  onContextMenu,
  ...rest
}: Omit<ViewProps, 'children'> & {
  onContextMenu: (position: { x: number; y: number }) => void;
  children?: ReactNode;
}) {
  return (
    <NativeContextMenuTarget
      onContextMenu={e =>
        onContextMenu({ x: e.nativeEvent.x, y: e.nativeEvent.y })
      }
      {...rest}
    />
  );
}
