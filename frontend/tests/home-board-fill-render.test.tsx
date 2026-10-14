import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { useBoardFill } from "../src/components/home/useBoardFill";
import { stubBoardLayout } from "./board-fill-layout";

afterEach(cleanup);

it("measures after every render without rendering again when nothing moved", async () => {
  const restore = stubBoardLayout({ panel: 4 * 52 });
  let renders = 0;
  let bump = () => {};
  function Panel() {
    renders++;
    const [, setTick] = useState(0);
    bump = () => setTick((n) => n + 1);
    const fill = useBoardFill(2);
    return (
      <div data-panel="panel">
        <div {...fill.area}>
          <ul className="board-list">
            {Array.from({ length: fill.count }, (_, i) => <li key={i} className="board-row" />)}
          </ul>
        </div>
      </div>
    );
  }
  try {
    render(<Panel />);
    await act(async () => {});
    expect(document.querySelectorAll(".board-row")).toHaveLength(4);
    const settled = renders;
    for (let i = 0; i < 3; i++) await act(async () => bump());
    // One render per bump: the measure after each finds nothing changed.
    expect(renders - settled).toBe(3);
  } finally {
    restore();
  }
});

it("stops a fill that never settles before React gives up on the page", async () => {
  // Room that flips with every measure: a layout that never settles.
  let flip = false;
  const room = { get panel() { flip = !flip; return flip ? 4 * 52 : 8 * 52; } };
  const restore = stubBoardLayout(room as unknown as Record<string, number>);
  function Panel() {
    const fill = useBoardFill(2);
    return (
      <div data-panel="panel">
        <div {...fill.area}>
          <ul className="board-list">
            {Array.from({ length: fill.count }, (_, i) => <li key={i} className="board-row" />)}
          </ul>
        </div>
      </div>
    );
  }
  try {
    expect(() => render(<Panel />)).not.toThrow();
    await act(async () => {});
    expect(document.querySelectorAll(".board-row").length).toBeGreaterThan(0);
  } finally {
    restore();
  }
  // The budget comes back after the run: a fill that settles still fills.
  cleanup();
  const settle = stubBoardLayout({ panel: 6 * 52 });
  try {
    render(<Panel />);
    await act(async () => {});
    expect(document.querySelectorAll(".board-row")).toHaveLength(6);
  } finally {
    settle();
  }
});
