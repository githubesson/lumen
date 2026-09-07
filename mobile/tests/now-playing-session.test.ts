/**
 * Lock-screen / Control Center session policy. Pause must not drop the OS
 * now-playing entry; only an empty local player or a cast target should.
 */
import { describe, expect, it } from "vitest";

import { shouldExposeNowPlayingSession } from "../context/now-playing-session";

describe("shouldExposeNowPlayingSession", () => {
  it("keeps the session while a track is loaded locally", () => {
    expect(
      shouldExposeNowPlayingSession({ hasTrack: true, isCasting: false }),
    ).toBe(true);
  });

  it("hides the session when nothing is loaded", () => {
    expect(
      shouldExposeNowPlayingSession({ hasTrack: false, isCasting: false }),
    ).toBe(false);
  });

  it("hides the session when another device owns playback", () => {
    expect(
      shouldExposeNowPlayingSession({ hasTrack: true, isCasting: true }),
    ).toBe(false);
  });
});
