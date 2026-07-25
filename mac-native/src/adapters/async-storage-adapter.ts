import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Storage } from '@music-library/core';

/**
 * Core's `Storage` over AsyncStorage. Every method swallows its error: storage
 * here backs preferences and caches, never correctness, so a failed write must
 * not take down playback or sign the user out.
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
