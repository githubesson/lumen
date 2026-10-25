import { useCallback, useLayoutEffect, useRef, useState } from "react";
import ReorderableList, {
  type ReorderableListDragEndEvent,
  type ReorderableListProps,
  type ReorderableListReorderEvent,
} from "react-native-reorderable-list";
import { scheduleOnRN } from "react-native-worklets";
import { rebaseDrop } from "../lib/reorder-drop";

type SteadyReorderableListProps<T> = Omit<
  ReorderableListProps<T>,
  "keyExtractor" | "onDragStart" | "onDragEnd"
> & {
  keyExtractor: (item: T, index: number) => string;
};

/**
 * A ReorderableList whose rows hold still from the start of a drag until its
 * drop is handled.
 *
 * The library reports a drop as indices into the rows it showed when the
 * drag began, and before that reads `keyExtractor(data[i])` for each index
 * in between without checking it against the current data. New data
 * mid-drag (a refetch) then moved the wrong row, and a shorter list crashed
 * the app (Sentry LUMEN-4). So the list keeps the rows it started the drag
 * on, and `onReorder` gets the drop replayed onto the latest `data`, which
 * the list shows from then on. A drop whose row is gone reports nothing.
 */
export function SteadyReorderableList<T>({
  data,
  keyExtractor,
  onReorder,
  ...props
}: SteadyReorderableListProps<T>) {
  const [held, setHeld] = useState<T[] | null>(null);
  const shown = held ?? data;
  // The drag callbacks run from the UI thread, and the drop from the closure
  // the list captured when the finger lifted, so they read the latest render
  // from here.
  const latest = useRef({ shown, data, keyExtractor, onReorder });
  useLayoutEffect(() => {
    latest.current = { shown, data, keyExtractor, onReorder };
  });

  const hold = useCallback(() => setHeld(latest.current.shown), []);
  const release = useCallback(() => setHeld(null), []);
  const onDragStart = useCallback(() => {
    "worklet";
    scheduleOnRN(hold);
  }, [hold]);
  const onDragEnd = useCallback(
    ({ from, to }: ReorderableListDragEndEvent) => {
      "worklet";
      // A row put back where it was never reaches onReorder.
      if (from === to) scheduleOnRN(release);
    },
    [release],
  );
  const handleReorder = useCallback(({ from, to }: ReorderableListReorderEvent) => {
    const { shown: dragged, data: current, keyExtractor: key, onReorder: report } =
      latest.current;
    setHeld(null);
    const move = rebaseDrop(dragged.map(key), current.map(key), from, to);
    if (move) report(move);
  }, []);

  return (
    <ReorderableList<T>
      {...props}
      data={shown}
      keyExtractor={keyExtractor}
      onReorder={handleReorder}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    />
  );
}
