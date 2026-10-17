import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";

/**
 * Smooth mix's crossfade on this device, in seconds; 0 is off. A module
 * singleton read through `useSyncExternalStore`, like the offline store. The
 * saved length loads when something first subscribes (the player, at launch).
 */

const KEY = "smooth-mix.seconds.v1"; // AsyncStorage; seconds as a string

type Listener = () => void;

class SmoothMixStore {
  private seconds = 0;
  private loadStarted = false;
  private chosen = false;
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.load();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get = (): number => this.seconds;

  set(seconds: number): void {
    this.chosen = true;
    if (seconds === this.seconds) return;
    this.seconds = seconds;
    this.emit();
    // Persistence is best-effort; the in-memory value drives this session.
    AsyncStorage.setItem(KEY, String(seconds)).catch(() => {});
  }

  private load(): void {
    if (this.loadStarted) return;
    this.loadStarted = true;
    void AsyncStorage.getItem(KEY)
      .then((raw) => {
        // A choice made while this was reading stands.
        if (this.chosen || raw === null) return;
        const seconds = Number(raw);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds === this.seconds) return;
        this.seconds = seconds;
        this.emit();
      })
      .catch(() => {
        // Best effort: an unreadable value just means off.
      });
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const smoothMixStore = new SmoothMixStore();

// Three arguments for the same reason as the offline hooks: web prerendering
// needs a server snapshot.
export function useSmoothMix(): number {
  return useSyncExternalStore(smoothMixStore.subscribe, smoothMixStore.get, smoothMixStore.get);
}
