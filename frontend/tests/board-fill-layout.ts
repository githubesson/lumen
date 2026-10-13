import { vi } from "vitest";

/**
 * Lays out what jsdom can't, for Home's fill areas (useBoardFill): board rows
 * are 52px tall, and each panel named in `room` has that many pixels for its
 * items. Returns the undo.
 */
export function stubBoardLayout(room: Record<string, number>): () => void {
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const height = this.classList.contains("board-row") ? 52 : 0;
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height, toJSON: () => ({}) };
  });
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    const id = this.closest<HTMLElement>("[data-panel]")?.dataset.panel;
    return this.classList.contains("board-fill") && id ? (room[id] ?? 0) : 0;
  });
  return () => {
    rect.mockRestore();
    height.mockRestore();
  };
}
