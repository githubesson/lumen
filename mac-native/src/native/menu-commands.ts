import { NativeEventEmitter, NativeModules } from 'react-native';

export type MenuCommandId =
  | 'playPause'
  | 'next'
  | 'previous'
  | 'shuffle'
  | 'repeat'
  | 'volumeUp'
  | 'volumeDown'
  | 'mute'
  | 'goHome'
  | 'goBrowse'
  | 'goFavorites'
  | 'goPlaylists'
  | 'goSettings'
  | 'toggleNowPlaying'
  | 'back'
  | 'search';

export interface PlaybackMenuState {
  hasTrack: boolean;
  isPlaying: boolean;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
}

interface LMMenuCommandsNativeModule {
  setPlaybackState(state: PlaybackMenuState): void;
}

const nativeModule = NativeModules.LMMenuCommandsModule as
  | LMMenuCommandsNativeModule
  | undefined;

if (!nativeModule) {
  throw new Error(
    'LMMenuCommandsModule is missing. Run `pod install --project-directory=macos` and rebuild.',
  );
}

export const MenuCommands = nativeModule;

export const menuCommandEvents = new NativeEventEmitter(
  NativeModules.LMMenuCommandsModule,
);

export function onMenuCommand(handler: (id: MenuCommandId) => void) {
  return menuCommandEvents.addListener(
    'menuCommand',
    ({ id }: { id: MenuCommandId }) => handler(id),
  );
}

/** Escape is reported rather than consumed; JS decides if anything is open. */
export function onEscape(handler: () => void) {
  return menuCommandEvents.addListener('escape', handler);
}
