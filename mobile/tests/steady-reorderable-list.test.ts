import type { ReactElement } from "react";
import type {
  ReorderableListDragEndEvent,
  ReorderableListDragStartEvent,
  ReorderableListReorderEvent,
} from "react-native-reorderable-list";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SteadyReorderableList } from "../components/steady-reorderable-list";

// Just enough React to render the list outside a renderer: hook cells kept by
// call order across renders, and layout effects run once a render is done.
const hooks = vi.hoisted(() => ({
  cells: [] as unknown[],
  cursor: 0,
  layoutEffects: [] as (() => void)[],
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: <T>(initial: T) => {
    const cell = hooks.cursor++;
    if (!(cell in hooks.cells)) hooks.cells[cell] = initial;
    return [hooks.cells[cell], (next: T) => (hooks.cells[cell] = next)];
  },
  useRef: <T>(initial: T) => {
    const cell = hooks.cursor++;
    if (!(cell in hooks.cells)) hooks.cells[cell] = { current: initial };
    return hooks.cells[cell];
  },
  useCallback: <T>(fn: T) => fn,
  useLayoutEffect: (effect: () => void) => {
    hooks.layoutEffects.push(effect);
  },
}));
// Worklets run inline; the UI thread is out of the picture here.
vi.mock("react-native-worklets", () => ({
  scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
}));
vi.mock("react-native-reorderable-list", () => ({ default: () => null }));

type Row = { key: string };
type ListProps = {
  data: Row[];
  keyExtractor: (item: Row, index: number) => string;
  onReorder: (event: ReorderableListReorderEvent) => void;
  onDragStart: (event: ReorderableListDragStartEvent) => void;
  onDragEnd: (event: ReorderableListDragEndEvent) => void;
};

const rows = (...keys: string[]): Row[] => keys.map((key) => ({ key }));
const onReorder = vi.fn<(event: ReorderableListReorderEvent) => void>();

/** Renders the list with `data` and returns what it hands ReorderableList. */
function render(data: Row[], report = onReorder): ListProps {
  hooks.cursor = 0;
  const element = SteadyReorderableList<Row>({
    data,
    keyExtractor: (row) => row.key,
    onReorder: report,
    renderItem: () => null,
  }) as ReactElement<ListProps>;
  for (const effect of hooks.layoutEffects.splice(0)) effect();
  return element.props;
}

/**
 * What react-native-reorderable-list 0.18 does when a drop lands
 * (`reorder` → `markCells` in ReorderableListCore): read the key of every
 * row between the two indices, then report the move.
 */
function landDrop(list: ListProps, from: number, to: number) {
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
    list.keyExtractor(list.data[i], i);
  }
  list.onReorder({ from, to });
}

beforeEach(() => {
  hooks.cells = [];
  hooks.layoutEffects = [];
  onReorder.mockReset();
});

describe("SteadyReorderableList", () => {
  it("shows its data while nothing is dragged", () => {
    const five = rows("a", "b", "c", "d", "e");
    expect(render(five).data).toBe(five);
    const four = rows("a", "b", "c", "d");
    expect(render(four).data).toBe(four);
  });

  it("holds the rows a drag began on while a refetch shrinks the list (LUMEN-4)", () => {
    const five = rows("a", "b", "c", "d", "e");
    render(five).onDragStart({ index: 4 });
    // A refetch drops "c" mid-drag: indices 4 and up no longer exist.
    const four = rows("a", "b", "d", "e");
    let list = render(four);
    expect(list.data).toBe(five);

    // Last row up to second place. Before the fix the library read
    // keyExtractor(four[4]) here and crashed on `undefined.key`.
    list.onDragEnd({ from: 4, to: 1 });
    expect(() => landDrop(list, 4, 1)).not.toThrow();
    expect(onReorder).toHaveBeenCalledExactlyOnceWith({ from: 3, to: 1 });

    // Once the drop is handled the list takes the refetched rows.
    list = render(four);
    expect(list.data).toBe(four);
  });

  it("replays a drop onto rows a refetch reordered", () => {
    const before = rows("a", "b", "c", "d");
    render(before).onDragStart({ index: 0 });
    const after = rows("b", "a", "c", "d");
    const list = render(after);
    expect(list.data).toBe(before);
    list.onDragEnd({ from: 0, to: 3 });
    landDrop(list, 0, 3);
    expect(onReorder).toHaveBeenCalledExactlyOnceWith({ from: 1, to: 3 });
  });

  it("reports nothing when the dragged row is gone by the drop", () => {
    render(rows("a", "b", "c")).onDragStart({ index: 2 });
    const left = rows("a", "b");
    const list = render(left);
    list.onDragEnd({ from: 2, to: 0 });
    landDrop(list, 2, 0);
    expect(onReorder).not.toHaveBeenCalled();
    expect(render(left).data).toBe(left);
  });

  it("lets go when a row is put back where it was, which never reaches onReorder", () => {
    render(rows("a", "b", "c")).onDragStart({ index: 1 });
    const fresh = rows("a", "b", "c", "d");
    const list = render(fresh);
    expect(list.data).not.toBe(fresh);
    list.onDragEnd({ from: 1, to: 1 });
    expect(render(fresh).data).toBe(fresh);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("calls the latest onReorder with the latest rows", () => {
    const list = render(rows("a", "b", "c"));
    list.onDragStart({ index: 0 });
    const latest = vi.fn();
    render(rows("a", "c", "b"), latest);
    // The library calls the onReorder it captured when the finger lifted,
    // from an older render.
    list.onDragEnd({ from: 0, to: 2 });
    landDrop(list, 0, 2);
    expect(onReorder).not.toHaveBeenCalled();
    // "a" goes under "c", in the order the playlist has now.
    expect(latest).toHaveBeenCalledExactlyOnceWith({ from: 0, to: 1 });
  });
});
