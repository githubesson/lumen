/**
 * Whether to hand an HLS stream straight to the media element instead of
 * loading hls.js. Only Apple's WebKit: Chromium also answers
 * `canPlayType("application/vnd.apple.mpegurl")` with "maybe" since it
 * shipped a built-in HLS player, but that player isn't verified with TIDAL's
 * fMP4/FLAC streams and has none of hls.js's error recovery.
 */
export function usesNativeHls(media: HTMLMediaElement): boolean {
  return /Apple/.test(navigator.vendor) && media.canPlayType("application/vnd.apple.mpegurl") !== "";
}
