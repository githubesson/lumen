import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Storage } from "@music-library/core";

/**
 * Mobile implementation of the shared `Storage` interface, backed by
 * `@react-native-async-storage/async-storage`. Errors are swallowed because
 * callers treat persisted values as best-effort (player volume, theme mode).
 */
export const asyncStorageAdapter: Storage = {
  async getItem(key) {
    try {
      return await AsyncStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async setItem(key, value) {
    try {
      await AsyncStorage.setItem(key, value);
    } catch {
      /* ignored */
    }
  },
  async removeItem(key) {
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      /* ignored */
    }
  },
};
