import { requireOptionalNativeModule } from "expo-modules-core";
import type { EventSubscription } from "expo-modules-core";

import type {
  SiriAuthorizationStatus,
  SiriMediaItem,
  SiriMediaNativeModule,
  SiriPlaybackResult,
  SiriPlayMediaRequest,
} from "./SiriMedia.types";

const nativeModule =
  requireOptionalNativeModule<SiriMediaNativeModule>("SiriMedia");

const noopSubscription: EventSubscription = {
  remove() {},
};

export function isSiriMediaAvailable() {
  return nativeModule != null;
}

export function getPendingSiriMediaRequests() {
  return nativeModule?.getPendingRequests() ?? Promise.resolve([]);
}

export function completeSiriMediaResolution(
  requestId: string,
  items: SiriMediaItem[],
) {
  return nativeModule?.completeResolution(requestId, items) ?? Promise.resolve();
}

export function completeSiriMediaPlayback(
  requestId: string,
  result: SiriPlaybackResult,
) {
  return nativeModule?.completePlayback(requestId, result) ?? Promise.resolve();
}

export function siriAuthorizationStatus(): SiriAuthorizationStatus {
  return nativeModule?.authorizationStatus() ?? "unavailable";
}

export function requestSiriAuthorization() {
  return nativeModule?.requestAuthorization() ??
    Promise.resolve<SiriAuthorizationStatus>("unavailable");
}

export function setSiriPlaylistVocabulary(names: string[]) {
  return nativeModule?.setPlaylistVocabulary(names) ?? Promise.resolve();
}

export function donateSiriPlayback(
  item: SiriMediaItem,
  container: SiriMediaItem | null = null,
  playShuffled = false,
) {
  return (
    nativeModule?.donatePlayback(item, container, playShuffled) ??
    Promise.resolve(false)
  );
}

export function addSiriPlayMediaRequestListener(
  listener: (event: SiriPlayMediaRequest) => void,
) {
  return (
    nativeModule?.addListener("onPlayMediaRequest", listener) ??
    noopSubscription
  );
}
