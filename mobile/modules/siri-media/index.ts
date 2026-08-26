export {
  addSiriPlayMediaRequestListener,
  completeSiriMediaPlayback,
  completeSiriMediaResolution,
  donateSiriPlayback,
  getPendingSiriMediaRequests,
  isSiriMediaAvailable,
  requestSiriAuthorization,
  setSiriPlaylistVocabulary,
  siriAuthorizationStatus,
} from "./src/SiriMediaModule";
export type {
  SiriAuthorizationStatus,
  SiriMediaItem,
  SiriMediaKind,
  SiriMediaNativeModule,
  SiriPlaybackResult,
  SiriPlayMediaRequest,
} from "./src/SiriMedia.types";
