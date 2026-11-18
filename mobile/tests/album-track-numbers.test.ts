import { expect, it } from "vitest";
import { albumTrackNumbers } from "../lib/album-track-numbers";

const numbers = (...nos: (number | undefined)[]) =>
  albumTrackNumbers(nos.map((track_no) => ({ track_no })));

it("keeps a disc's own numbers, gaps and all", () => {
  expect(numbers(1, 2, 3)).toEqual([1, 2, 3]);
  // An album still downloading: only some tracks are saved yet.
  expect(numbers(2, 5, 9)).toEqual([2, 5, 9]);
});

it("counts down the list when the numbers would repeat or are missing", () => {
  // A second disc starting again at 1.
  expect(numbers(1, 2, 1, 2)).toEqual([1, 2, 3, 4]);
  // Untagged tracks sort first in the library.
  expect(numbers(undefined, undefined, 1, 2)).toEqual([1, 2, 3, 4]);
  // An unmatched library copy appended after the release.
  expect(numbers(1, 2, 3, 2)).toEqual([1, 2, 3, 4]);
  // A TIDAL entry with no number.
  expect(numbers(1, undefined, 3)).toEqual([1, 2, 3]);
});

it("handles an empty album", () => {
  expect(numbers()).toEqual([]);
});
