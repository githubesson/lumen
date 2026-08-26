import type { EventSubscription } from "expo-modules-core";

export type SiriAuthorizationStatus =
  | "authorized"
  | "denied"
  | "notDetermined"
  | "restricted"
  | "unavailable";

export type SiriMediaKind =
  | "album"
  | "artist"
  | "music"
  | "playlist"
  | "song"
  | "unknown";

export type SiriMediaItem = {
  identifier: string;
  title: string;
  type: SiriMediaKind;
  artist?: string;
};

export type SiriPlayMediaRequest = {
  requestId: string;
  phase: "play" | "resolve";
  mediaName?: string;
  artistName?: string;
  albumName?: string;
  mediaIdentifier?: string;
  mediaType: SiriMediaKind;
  mediaItems: SiriMediaItem[];
  mediaContainer?: SiriMediaItem;
  playShuffled?: boolean;
  resumePlayback?: boolean;
};

export type SiriPlaybackResult =
  | "failure"
  | "noContent"
  | "requiresAppLaunch"
  | "success"
  | "unsupported";

export type SiriMediaNativeModule = {
  getPendingRequests(): Promise<SiriPlayMediaRequest[]>;
  completeResolution(
    requestId: string,
    items: SiriMediaItem[],
  ): Promise<void>;
  completePlayback(
    requestId: string,
    result: SiriPlaybackResult,
  ): Promise<void>;
  authorizationStatus(): SiriAuthorizationStatus;
  requestAuthorization(): Promise<SiriAuthorizationStatus>;
  setPlaylistVocabulary(names: string[]): Promise<void>;
  donatePlayback(
    item: SiriMediaItem,
    container: SiriMediaItem | null,
    playShuffled: boolean,
  ): Promise<boolean>;
  addListener(
    eventName: "onPlayMediaRequest",
    listener: (event: SiriPlayMediaRequest) => void,
  ): EventSubscription;
};
