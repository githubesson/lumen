// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useEditDraft } from "../src/use-edit-draft";

interface Item {
  title: string;
  genre: string;
}

const toForm = (item: Item) => ({ title: item.title, genre: item.genre });

describe("useEditDraft", () => {
  it("refills from fresher data until the first edit", () => {
    const cached: Item = { title: "Old", genre: "Rock" };
    const fresh: Item = { title: "Old", genre: "Jazz" };
    const { result, rerender } = renderHook(({ item }) => useEditDraft(item, toForm), {
      initialProps: { item: cached },
    });
    expect(result.current.draft).toEqual({ title: "Old", genre: "Rock" });

    rerender({ item: fresh });
    expect(result.current.base).toBe(fresh);
    expect(result.current.draft).toEqual({ title: "Old", genre: "Jazz" });
  });

  it("keeps the base and draft once edited, so a refetch can't add changes", () => {
    const cached: Item = { title: "Old", genre: "Rock" };
    const { result, rerender } = renderHook(({ item }) => useEditDraft(item, toForm), {
      initialProps: { item: cached },
    });
    act(() => result.current.setField("title", "New"));

    // Another device changed the genre meanwhile.
    rerender({ item: { title: "Old", genre: "Jazz" } });
    expect(result.current.base).toBe(cached);
    expect(result.current.draft).toEqual({ title: "New", genre: "Rock" });
  });

  it("keeps setField stable across renders", () => {
    const { result, rerender } = renderHook(({ item }) => useEditDraft(item, toForm), {
      initialProps: { item: { title: "A", genre: "" } as Item },
    });
    const first = result.current.setField;
    rerender({ item: { title: "B", genre: "" } });
    expect(result.current.setField).toBe(first);
  });
});
