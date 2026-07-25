import { useEffect } from 'react';
import { clampVolume } from '@music-library/core';
import {
  MenuCommands,
  onEscape,
  onMenuCommand,
  type MenuCommandId,
} from '../native/menu-commands';
import {
  useCurrentTrack,
  useIsPlaying,
  usePlayerControls,
  useTransport,
} from '../context/player';
import { useNavigation } from '../navigation/navigation';
import { useOverlay } from './overlay-context';

const VOLUME_STEP = 0.05;

/**
 * Routes main-menu commands (and their key equivalents) to the app. Keeping
 * this in one place means every shortcut is visible in the menu bar rather than
 * being an undiscoverable key handler buried in a component.
 */
export function useMenuBindings(onSearch: () => void) {
  const controls = usePlayerControls();
  const { volume, muted, shuffle, repeat } = useTransport();
  const track = useCurrentTrack();
  const isPlaying = useIsPlaying();
  const { selectSection, pop } = useNavigation();
  const { toggleNowPlaying, nowPlayingOpen, closeNowPlaying } = useOverlay();

  useEffect(() => {
    const subscription = onEscape(() => {
      if (nowPlayingOpen) closeNowPlaying();
    });
    return () => subscription.remove();
  }, [nowPlayingOpen, closeNowPlaying]);

  useEffect(() => {
    const subscription = onMenuCommand((id: MenuCommandId) => {
      switch (id) {
        case 'playPause':
          controls.toggle();
          break;
        case 'next':
          controls.next();
          break;
        case 'previous':
          controls.prev();
          break;
        case 'shuffle':
          controls.toggleShuffle();
          break;
        case 'repeat':
          controls.cycleRepeat();
          break;
        case 'volumeUp':
          controls.setVolume(clampVolume(volume + VOLUME_STEP));
          break;
        case 'volumeDown':
          controls.setVolume(clampVolume(volume - VOLUME_STEP));
          break;
        case 'mute':
          controls.toggleMute();
          break;
        case 'goHome':
          selectSection('home');
          break;
        case 'goBrowse':
          selectSection('browse');
          break;
        case 'goFavorites':
          selectSection('favorites');
          break;
        case 'goPlaylists':
          selectSection('playlists');
          break;
        case 'goSettings':
          selectSection('settings');
          break;
        case 'toggleNowPlaying':
          toggleNowPlaying();
          break;
        case 'back':
          pop();
          break;
        case 'search':
          selectSection('browse');
          onSearch();
          break;
      }
    });
    return () => subscription.remove();
  }, [controls, volume, selectSection, pop, toggleNowPlaying, onSearch]);

  // Mirror player state into the menu so titles and enabled states stay true.
  useEffect(() => {
    MenuCommands.setPlaybackState({
      hasTrack: Boolean(track),
      isPlaying,
      shuffle,
      repeat,
    });
  }, [track, isPlaying, shuffle, repeat, muted]);
}
