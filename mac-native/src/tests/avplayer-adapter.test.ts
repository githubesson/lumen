import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { AudioAdapterEvent } from '@music-library/core';

/**
 * The adapter is the seam between core's player and the AppKit module, so what
 * matters is the contract: every native event maps to exactly one core event,
 * and the synchronous accessors core polls (`currentTime`, `duration`) reflect
 * the last tick.
 */

type NativeListener = (payload: unknown) => void;

const listeners = new Map<string, Set<NativeListener>>();
const playback = {
  load: vi.fn(),
  play: vi.fn(() => Promise.resolve()),
  pause: vi.fn(),
  seek: vi.fn(),
  setVolume: vi.fn(),
  setMuted: vi.fn(),
  dispose: vi.fn(),
  setNowPlayingInfo: vi.fn(),
  clearNowPlayingInfo: vi.fn(),
  setRemoteCommandsEnabled: vi.fn(),
};

function emitNative(event: string, payload: unknown = {}) {
  for (const listener of listeners.get(event) ?? []) listener(payload);
}

vi.mock('../native/playback', () => ({
  Playback: playback,
  playbackEvents: {
    addListener(event: string, handler: NativeListener) {
      const set = listeners.get(event) ?? new Set<NativeListener>();
      set.add(handler);
      listeners.set(event, set);
      return {
        remove() {
          set.delete(handler);
        },
      };
    },
  },
}));

const { useAVPlayerAdapter } = await import('../adapters/avplayer-adapter');

function setup() {
  const { result, unmount } = renderHook(() => useAVPlayerAdapter());
  const seen: AudioAdapterEvent[] = [];
  const events: AudioAdapterEvent[] = [
    'loadedmetadata',
    'timeupdate',
    'play',
    'pause',
    'seeked',
    'ended',
  ];
  for (const event of events) {
    result.current.on(event, () => seen.push(event));
  }
  return { adapter: result.current, seen, unmount };
}

beforeEach(() => {
  listeners.clear();
  vi.clearAllMocks();
});

describe('useAVPlayerAdapter', () => {
  it('forwards each native event to core exactly once', () => {
    const { seen } = setup();

    act(() => {
      emitNative('loadedmetadata', { duration: 210 });
      emitNative('timeupdate', { currentTime: 1 });
      emitNative('play');
      emitNative('pause');
      emitNative('seeked');
      emitNative('ended');
    });

    expect(seen).toEqual([
      'loadedmetadata',
      'timeupdate',
      'play',
      'pause',
      'seeked',
      'ended',
    ]);
  });

  it('exposes the latest position and duration synchronously', () => {
    const { adapter } = setup();

    act(() => {
      emitNative('loadedmetadata', { duration: 210 });
      emitNative('timeupdate', { currentTime: 42.5 });
    });

    expect(adapter.duration()).toBe(210);
    expect(adapter.currentTime()).toBe(42.5);
  });

  it('ignores non-finite values the player reports before an item is ready', () => {
    const { adapter } = setup();

    act(() => {
      emitNative('loadedmetadata', { duration: Number.NaN });
      emitNative('timeupdate', { currentTime: Number.POSITIVE_INFINITY });
    });

    expect(adapter.duration()).toBe(0);
    expect(adapter.currentTime()).toBe(0);
  });

  it('resets position on load so the previous track does not linger', () => {
    const { adapter } = setup();

    act(() => {
      emitNative('loadedmetadata', { duration: 210 });
      emitNative('timeupdate', { currentTime: 90 });
    });
    adapter.load('https://example.test/stream');

    expect(playback.load).toHaveBeenCalledWith('https://example.test/stream');
    expect(adapter.currentTime()).toBe(0);
    expect(adapter.duration()).toBe(0);
  });

  it('reports the seek target immediately, before the native seek lands', () => {
    const { adapter } = setup();

    adapter.seek(30);

    expect(playback.seek).toHaveBeenCalledWith(30);
    expect(adapter.currentTime()).toBe(30);
  });

  it('stops delivering to a handler once it unsubscribes', () => {
    const { adapter } = setup();
    const calls: string[] = [];
    const off = adapter.on('play', () => calls.push('play'));

    act(() => emitNative('play'));
    off();
    act(() => emitNative('play'));

    expect(calls).toHaveLength(1);
  });

  it('detaches from the native emitter on unmount', () => {
    const { unmount } = setup();
    expect(listeners.get('play')?.size).toBe(1);
    unmount();
    expect(listeners.get('play')?.size ?? 0).toBe(0);
  });
});
