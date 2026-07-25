import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import {
  trackCoverUrl,
  usePlayerCore,
  type PlayerControls,
  type PlayerState,
  type TimeState,
  type TrackListItem,
} from '@music-library/core';
import { useAVPlayerAdapter } from '../adapters/avplayer-adapter';
import { asyncStorageAdapter } from '../adapters/async-storage-adapter';
import { Playback, playbackEvents, type RemoteCommandPayload } from '../native/playback';

/**
 * Player state is split across several contexts, matching the iOS client.
 * A single context would re-render every consumer on each `timeupdate` — the
 * scrubber ticks twice a second, and the sidebar and track lists have no reason
 * to re-render with it.
 */
const CurrentContext = createContext<TrackListItem | null>(null);
const IsPlayingContext = createContext(false);
const QueueContext = createContext<{ queue: TrackListItem[]; index: number }>({
  queue: [],
  index: -1,
});
const TimeContext = createContext<TimeState>({ currentTime: 0, duration: 0 });
const TransportContext = createContext<
  Pick<PlayerState, 'volume' | 'muted' | 'shuffle' | 'repeat'>
>({ volume: 1, muted: false, shuffle: false, repeat: 'off' });
const ControlsContext = createContext<PlayerControls | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const adapter = useAVPlayerAdapter();
  const { state, controls, time } = usePlayerCore({
    adapter,
    storage: asyncStorageAdapter,
    // A desktop window is effectively always foregrounded, so smooth the
    // 0.5s native ticks into a 60fps scrubber.
    interpolateProgress: true,
  });

  // Publish to the system Now Playing widget and Control Center. Elapsed time
  // is not included here: the native side refreshes it whenever the rate
  // changes or a seek lands, which avoids pushing metadata twice a second.
  const current = state.current;
  useEffect(() => {
    if (!current) {
      Playback.clearNowPlayingInfo();
      return;
    }
    Playback.setNowPlayingInfo({
      title: current.title,
      artist: current.artist ?? undefined,
      album: current.album_title ?? undefined,
      duration: current.duration_ms > 0 ? current.duration_ms / 1000 : undefined,
      artworkUrl: trackCoverUrl(current, 512),
    });
  }, [current]);

  // Media keys, Control Center and the Now Playing widget.
  useEffect(() => {
    Playback.setRemoteCommandsEnabled(true);
    const subscription = playbackEvents.addListener(
      'remoteCommand',
      ({ action, position }: RemoteCommandPayload) => {
        switch (action) {
          case 'play':
            controls.resume();
            break;
          case 'pause':
            controls.pause();
            break;
          case 'toggle':
            controls.toggle();
            break;
          case 'next':
            controls.next();
            break;
          case 'previous':
            controls.prev();
            break;
          case 'seek':
            if (typeof position === 'number') controls.seek(position);
            break;
        }
      },
    );
    return () => {
      subscription.remove();
      Playback.setRemoteCommandsEnabled(false);
    };
  }, [controls]);

  const queueValue = useMemo(
    () => ({ queue: state.queue, index: state.index }),
    [state.queue, state.index],
  );
  const transportValue = useMemo(
    () => ({
      volume: state.volume,
      muted: state.muted,
      shuffle: state.shuffle,
      repeat: state.repeat,
    }),
    [state.volume, state.muted, state.shuffle, state.repeat],
  );

  return (
    <ControlsContext.Provider value={controls}>
      <CurrentContext.Provider value={state.current}>
        <IsPlayingContext.Provider value={state.isPlaying}>
          <QueueContext.Provider value={queueValue}>
            <TransportContext.Provider value={transportValue}>
              <TimeContext.Provider value={time}>{children}</TimeContext.Provider>
            </TransportContext.Provider>
          </QueueContext.Provider>
        </IsPlayingContext.Provider>
      </CurrentContext.Provider>
    </ControlsContext.Provider>
  );
}

export function useCurrentTrack(): TrackListItem | null {
  return useContext(CurrentContext);
}

export function useIsPlaying(): boolean {
  return useContext(IsPlayingContext);
}

export function usePlayerQueue() {
  return useContext(QueueContext);
}

export function usePlayerTime(): TimeState {
  return useContext(TimeContext);
}

export function useTransport() {
  return useContext(TransportContext);
}

export function usePlayerControls(): PlayerControls {
  const controls = useContext(ControlsContext);
  if (!controls) throw new Error('usePlayerControls requires PlayerProvider');
  return controls;
}

/** Start a track, optionally replacing the queue with the list it came from. */
export function usePlayTrack(): (
  track: TrackListItem,
  queue?: TrackListItem[],
) => void {
  return usePlayerControls().play;
}
