import { useSyncExternalStore } from "react";
import { AccessibilityInfo, Alert } from "react-native";
import { errorMessage } from "@music-library/core";

/** A rectangle in window points. */
export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How an add ended: the HUD's check waits on it, a failure becomes an alert. */
export type AddConfirmationResult =
  | { ok: true }
  | { ok: false; title: string; message: string };

export interface AddConfirmationRequest {
  /**
   * Where the track's cover sat on screen when the picker closed. The cover
   * flies from there into the HUD; null skips the flight.
   */
  from: WindowRect | null;
  /** The track's cover. `placeholder` is the copy the picker already showed. */
  trackArt: { uri: string | null; placeholder: string | null };
  playlistName: string;
  /**
   * The playlist's cover, or null when it has none yet (a new or empty
   * playlist): its tile then fills with the track's art as the cover lands,
   * since a playlist's art is its first track's.
   */
  playlistArt: { uri: string; placeholder: string | null } | null;
  /** Glyph for the empty tile. */
  playlistGlyph: "music.note.list" | "person.2.fill";
  /** Made for this add: the HUD says "New Playlist" rather than "Added". */
  created: boolean;
  /** The add itself, already running. */
  done: Promise<AddConfirmationResult>;
}

export interface AddConfirmation extends AddConfirmationRequest {
  id: number;
}

/**
 * Alerts and announcements wait this long after the tap: the picker sheet is
 * still closing before then, and UIKit drops an alert presented over a sheet
 * mid-dismissal.
 */
const SHEET_CLOSE_MS = 650;

let current: AddConfirmation | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot() {
  return current;
}

/**
 * Shows the add-to-playlist confirmation over everything, replacing one
 * still on screen. The outcome reaches the user whatever the HUD is doing:
 * VoiceOver hears it, and a failure is the alert the picker used to show.
 */
export function showAddConfirmation(request: AddConfirmationRequest): void {
  const startedAt = Date.now();
  // The HUD waits on `done`, so it must settle into a result, never reject.
  const done = request.done.catch(
    (error: unknown): AddConfirmationResult => ({
      ok: false,
      title: "Couldn't add track",
      message: errorMessage(error, "Please try again."),
    }),
  );
  current = { ...request, done, id: nextId++ };
  emit();
  const afterSheetCloses = (run: () => void) => {
    setTimeout(run, Math.max(0, SHEET_CLOSE_MS - (Date.now() - startedAt)));
  };
  void done.then((result) => {
    if (result.ok) {
      afterSheetCloses(() =>
        AccessibilityInfo.announceForAccessibility(
          request.created
            ? `Added to new playlist ${request.playlistName}`
            : `Added to ${request.playlistName}`,
        ),
      );
    } else {
      afterSheetCloses(() => Alert.alert(result.title, result.message));
    }
  });
}

/** The HUD is done with confirmation `id`. A newer one stays up. */
export function finishAddConfirmation(id: number): void {
  if (current?.id !== id) return;
  current = null;
  emit();
}

export function useAddConfirmation(): AddConfirmation | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
