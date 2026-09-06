// Re-export of the shared track-source predicates. The implementation lives in
// `core/src/track.ts` so the mobile app stops open-coding
// `track.source === "tidal"` at each call site and both clients answer
// "can this be edited / shared?" the same way.
export {
  canShareTrack,
  isLocalTrack,
  isTidalTrack,
} from "@music-library/core/track";
