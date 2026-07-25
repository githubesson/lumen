import { requireOptionalNativeModule } from "expo-modules-core";
import type { EventSubscription } from "expo-modules-core";

import type {
  CarPlayListLimits,
  CarPlayListTemplate,
  CarPlayNativeModule,
  CarPlayNowPlayingButtonEvent,
  CarPlayNowPlayingConfig,
  CarPlaySelectEvent,
} from "./CarPlay.types";

// Optional: absent on Android, on web, and in any build made before the
// CarPlay module existed. Every export below no-ops rather than throwing so
// callers can stay unconditional.
const nativeModule = requireOptionalNativeModule<CarPlayNativeModule>("CarPlay");

const noopSubscription: EventSubscription = {
  remove() {},
};

/**
 * The binary is older than this JavaScript whenever a dev client (or a
 * TestFlight build) predates a native change, and JS updates on its own. Calls
 * added since that build are therefore feature-detected rather than assumed:
 * missing ones no-op, so the car stays quiet instead of the app crashing on a
 * method that isn't there.
 */
function supports(method: keyof CarPlayNativeModule): boolean {
  return typeof nativeModule?.[method] === "function";
}

/** Registers an event the running binary may not declare — an undeclared name
 *  raises rather than returning a subscription that never fires. */
function addOptionalListener<Event>(
  eventName: string,
  listener: (event: Event) => void,
): EventSubscription {
  if (!nativeModule) return noopSubscription;
  const emitter = nativeModule as unknown as {
    addListener(
      name: string,
      listener: (event: Event) => void,
    ): EventSubscription;
  };

  try {
    return emitter.addListener(eventName, listener);
  } catch {
    return noopSubscription;
  }
}

// Only used when the native module is absent, where nothing is rendered
// anyway. Kept small so a hypothetical caller can't build an unbounded list.
const FALLBACK_LIMITS: CarPlayListLimits = {
  maximumItemCount: 100,
  maximumSectionCount: 10,
  maximumTabCount: 5,
  maximumImageRowCount: 4,
};

export function isCarPlayAvailable() {
  return nativeModule != null;
}

/** How much of a list the head unit will actually render. Build no more. */
export function carPlayListLimits(): CarPlayListLimits {
  if (!nativeModule) return FALLBACK_LIMITS;
  return {
    maximumItemCount: nativeModule.maximumItemCount,
    maximumSectionCount: nativeModule.maximumSectionCount,
    maximumTabCount:
      nativeModule.maximumTabCount ?? FALLBACK_LIMITS.maximumTabCount,
    maximumImageRowCount:
      nativeModule.maximumImageRowCount ?? FALLBACK_LIMITS.maximumImageRowCount,
  };
}

/** True while a car scene is attached. Read on mount — the scene may have
 *  connected before this JS runtime started. */
export function isCarPlayConnected() {
  return nativeModule?.isConnected() ?? false;
}

/**
 * Whether the app can read its own files right now.
 *
 * A car frequently connects to a locked phone, and one that has not been
 * unlocked since it booted keeps the cached session, the downloads and the
 * persisted library out of reach — which reads as "signed out" to everything
 * above it. True on a binary too old to answer, which is how it behaved
 * before this existed.
 */
export function isCarPlayProtectedDataAvailable() {
  if (!supports("isProtectedDataAvailable")) return true;
  return nativeModule?.isProtectedDataAvailable() ?? true;
}

export function setCarPlayRootList(template: CarPlayListTemplate) {
  return nativeModule?.setRootList(template) ?? Promise.resolve();
}

/** Installs the browse tabs. Resets the car's navigation stack, so this runs on
 *  connect and on account change only; later changes go through `updateList`. */
export function setCarPlayRootTabs(templates: CarPlayListTemplate[]) {
  if (!supports("setRootTabs")) return Promise.resolve();
  return nativeModule?.setRootTabs(templates) ?? Promise.resolve();
}

/** False on a binary built before tabs existed, where the bridge falls back to
 *  the single-list root rather than installing a root the car can't show. */
export function isCarPlayTabsSupported() {
  return supports("setRootTabs");
}

/** Moves to an installed tab — what a shelf's "see all" chevron does, rather
 *  than pushing a second copy of a list that is already a tab. */
export function selectCarPlayTab(templateId: string) {
  if (!supports("selectTab")) return Promise.resolve();
  return nativeModule?.selectTab(templateId) ?? Promise.resolve();
}

export function pushCarPlayList(template: CarPlayListTemplate, animated = true) {
  return nativeModule?.pushList(template, animated) ?? Promise.resolve();
}

export function updateCarPlayList(template: CarPlayListTemplate) {
  return nativeModule?.updateList(template) ?? Promise.resolve();
}

export function popCarPlayTemplate(animated = true) {
  return nativeModule?.popTemplate(animated) ?? Promise.resolve();
}

export function popCarPlayToRoot(animated = true) {
  return nativeModule?.popToRoot(animated) ?? Promise.resolve();
}

export function pushCarPlayNowPlaying(animated = true) {
  return nativeModule?.pushNowPlaying(animated) ?? Promise.resolve();
}

/** Buttons and system affordances on the now-playing screen. Call again
 *  whenever what they report — shuffle, repeat, favorite — changes. */
export function configureCarPlayNowPlaying(config: CarPlayNowPlayingConfig) {
  if (!supports("configureNowPlaying")) return Promise.resolve();
  return nativeModule?.configureNowPlaying(config) ?? Promise.resolve();
}

/** Stops the spinner on the row that raised `onSelect`. */
export function finishCarPlaySelection(selectionId: string) {
  return nativeModule?.finishSelection(selectionId) ?? Promise.resolve();
}

export function addCarPlayConnectListener(listener: () => void) {
  return nativeModule?.addListener("onConnect", listener) ?? noopSubscription;
}

export function addCarPlayDisconnectListener(listener: () => void) {
  return nativeModule?.addListener("onDisconnect", listener) ?? noopSubscription;
}

export function addCarPlaySelectListener(
  listener: (event: CarPlaySelectEvent) => void,
) {
  return nativeModule?.addListener("onSelect", listener) ?? noopSubscription;
}

export function addCarPlayNowPlayingButtonListener(
  listener: (event: CarPlayNowPlayingButtonEvent) => void,
) {
  return addOptionalListener("onNowPlayingButton", listener);
}

/** The system Up Next button: push the queue. */
export function addCarPlayUpNextListener(listener: () => void) {
  return addOptionalListener("onNowPlayingUpNext", listener);
}

/** The system album/artist button: push the container the track came from. */
export function addCarPlayAlbumArtistListener(listener: () => void) {
  return addOptionalListener("onNowPlayingAlbumArtist", listener);
}

/** Fires when the phone is unlocked for the first time since it booted, which
 *  is when everything the car reads from disk becomes readable. */
export function addCarPlayProtectedDataListener(listener: () => void) {
  return addOptionalListener("onProtectedDataAvailable", listener);
}
