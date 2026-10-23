import { describe, expect, it } from "vitest";
import { ApiError } from "@music-library/core";
import { isShareDismissal } from "../lib/share-dismissal";

describe("isShareDismissal", () => {
  it("recognises the share sheet's cancel and dismiss errors", () => {
    expect(isShareDismissal(new Error("User did not share"))).toBe(true);
    expect(isShareDismissal(new Error("The operation was cancelled"))).toBe(true);
    expect(isShareDismissal(new Error("Sheet dismissed"))).toBe(true);
    expect(isShareDismissal(new Error("Network request failed"))).toBe(false);
  });

  it("never takes an API failure for a dismissal, whatever its text", () => {
    expect(
      isShareDismissal(new ApiError(0, "cancel-party.jpg is no longer on this device. Choose it again.")),
    ).toBe(false);
    expect(isShareDismissal(new ApiError(409, "Render cancelled by the server"))).toBe(false);
  });
});
