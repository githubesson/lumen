import { NativeEventEmitter, NativeModules } from 'react-native';

export type PlaybackEvent =
  | 'loadedmetadata'
  | 'timeupdate'
  | 'play'
  | 'pause'
  | 'seeked'
  | 'ended'
  | 'error'
  | 'remoteCommand';

export interface NowPlayingInfo {
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  artworkUrl?: string;
}

export type RemoteCommandAction =
  | 'play'
  | 'pause'
  | 'toggle'
  | 'next'
  | 'previous'
  | 'seek';

export interface RemoteCommandPayload {
  action: RemoteCommandAction;
  position?: number;
}

interface LMPlaybackNativeModule {
  load(url: string): void;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  dispose(): void;
  setNowPlayingInfo(info: NowPlayingInfo): void;
  clearNowPlayingInfo(): void;
  setRemoteCommandsEnabled(enabled: boolean): void;
}

const nativeModule = NativeModules.LMPlaybackModule as
  | LMPlaybackNativeModule
  | undefined;

if (!nativeModule) {
  throw new Error(
    'LMPlaybackModule is missing. Run `pod install --project-directory=macos` and rebuild.',
  );
}

export const Playback = nativeModule;

/**
 * Single emitter for the module. `AVPlayer` state is process-wide, so multiple
 * emitters would only multiply listeners over the same event stream.
 */
export const playbackEvents = new NativeEventEmitter(
  NativeModules.LMPlaybackModule,
);
