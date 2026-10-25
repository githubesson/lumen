import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReorderableList, {
  type ReorderableListProps,
  type ReorderableListReorderEvent,
} from "react-native-reorderable-list";
import { scheduleOnRN } from "react-native-worklets";
import { rebaseDrop } from "../lib/reorder-drop";

/** The library's default `animationDuration`: how long a dropped row takes to settle. */
const DROP_ANIMATION_MS = 200;
/** Slack after the drop animation for the library's onReorder to reach JS. */
export const LET_GO_AFTER_DROP_MS = 300;

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
  const letGoMs = (props.animationDuration ?? DROP_ANIMATION_MS) + LET_GO_AFTER_DROP_MS;
  // The drag callbacks run from the UI thread, and the drop from the closure
  // the list captured when the finger lifted, so they read the latest render
  // from here.
  const latest = useRef({ shown, data, keyExtractor, onReorder, letGoMs });
  useLayoutEffect(() => {
    latest.current = { shown, data, keyExtractor, onReorder, letGoMs };
  });
  // The rows the current drag's indices refer to, kept even if the hold
  // lets go before its drop arrives.
  const dragRows = useRef<T[] | null>(null);
  const letGoTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(letGoTimer.current), []);

  const hold = useCallback(() => {
    clearTimeout(letGoTimer.current);
    dragRows.current = latest.current.shown;
    setHeld(dragRows.current);
  }, []);
  // The library calls onReorder once the dropped row has settled, except for
  // a row put back where it was, or a finger lifted exactly on the new slot.
  // Let go a little after the drop animation unless the drop came first.
  const settle = useCallback(() => {
    clearTimeout(letGoTimer.current);
    letGoTimer.current = setTimeout(() => setHeld(null), latest.current.letGoMs);
  }, []);
  const onDragStart = useCallback(() => {
    "worklet";
    scheduleOnRN(hold);
  }, [hold]);
  const onDragEnd = useCallback(() => {
    "worklet";
    scheduleOnRN(settle);
  }, [settle]);
  const handleReorder = useCallback(({ from, to }: ReorderableListReorderEvent) => {
    clearTimeout(letGoTimer.current);
    const { shown: dragged, data: current, keyExtractor: key, onReorder: report } =
      latest.current;
    const rows = dragRows.current ?? dragged;
    dragRows.current = null;
    setHeld(null);
    const move = rebaseDrop(rows.map(key), current.map(key), from, to);
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
