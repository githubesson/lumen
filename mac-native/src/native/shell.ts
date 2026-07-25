import { NativeEventEmitter, NativeModules } from 'react-native';

export interface ShellSidebarItem {
  id: string;
  label: string;
  /** SF Symbol name. */
  symbol: string;
}

export interface ShellSidebarSection {
  /** A section with no title is flattened to top-level rows, with no header. */
  title?: string;
  items: ShellSidebarItem[];
}

export interface ShellToolbarConfig {
  /** Native back chevron next to the sidebar toggle, for pushed screens. */
  showsBack?: boolean;
  showsSearch?: boolean;
  searchPlaceholder?: string;
  searchText?: string;
  segments?: string[];
  selectedSegment?: number;
}

interface LMShellNativeModule {
  /**
   * The window's resolved appearance at launch. React Native's own
   * `useColorScheme` cannot be used for this — see `LMShellModule`'s
   * `constantsToExport`.
   *
   * Optional because JS reloads without the app being rebuilt: a binary older
   * than this constant reports nothing, and callers fall back rather than
   * assuming a scheme.
   */
  initialScheme?: 'light' | 'dark';
  setSidebar(sections: ShellSidebarSection[], selectedId: string | null): void;
  setSelectedItem(id: string): void;
  toggleSidebar(): void;
  setToolbar(config: ShellToolbarConfig): void;
  focusSearch(): void;
  setAppearance(scheme: 'light' | 'dark' | 'system'): void;
  /** Collapse the sidebar and hide the toolbar for the expanded player. */
  setImmersive(immersive: boolean): void;
  /**
   * Sheet-style confirmation (`NSAlert`); resolves `true` on confirm. The
   * AppKit stand-in for React Native's `Alert`, which does not exist on macOS.
   */
  confirmDialog(options: {
    title: string;
    message?: string;
    confirmTitle?: string;
    destructive?: boolean;
  }): Promise<boolean>;
  /** Informational sheet with a single OK button. */
  alertDialog(options: { title: string; message?: string }): Promise<void>;
  /**
   * Save panel + authenticated download. Resolves the saved path, or `null`
   * when the user cancels the panel; rejects on network or filesystem errors.
   */
  saveDownload(url: string, suggestedName: string): Promise<string | null>;
}

const nativeModule = NativeModules.LMShellModule as
  | LMShellNativeModule
  | undefined;

if (!nativeModule) {
  throw new Error(
    'LMShellModule is missing. Run `pod install --project-directory=macos` and rebuild.',
  );
}

export const Shell = nativeModule;

const shellEvents = new NativeEventEmitter(NativeModules.LMShellModule);

/** Fires when a row is clicked in the native sidebar. */
export function onSidebarSelect(handler: (id: string) => void) {
  return shellEvents.addListener('sidebarSelect', ({ id }: { id: string }) =>
    handler(id),
  );
}

/** Fires on each keystroke in the toolbar's search field. */
export function onToolbarSearch(handler: (text: string) => void) {
  return shellEvents.addListener('toolbarSearch', ({ text }: { text: string }) =>
    handler(text),
  );
}

/** Fires when the app's effective light/dark appearance changes. */
export function onAppearanceChange(
  handler: (scheme: 'light' | 'dark') => void,
) {
  return shellEvents.addListener(
    'appearanceChange',
    ({ scheme }: { scheme: 'light' | 'dark' }) => handler(scheme),
  );
}

/** Fires when the toolbar's segmented control changes. */
export function onToolbarSegment(handler: (index: number) => void) {
  return shellEvents.addListener(
    'toolbarSegment',
    ({ index }: { index: number }) => handler(index),
  );
}

/** Fires when the toolbar's back button is clicked. */
export function onToolbarBack(handler: () => void) {
  return shellEvents.addListener('toolbarBack', () => handler());
}
