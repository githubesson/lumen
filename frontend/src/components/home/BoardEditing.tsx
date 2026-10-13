import { useRef, useState, type DragEvent, type DragEventHandler, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import {
  ArrowLeftRight as SwapIcon,
  Check as CheckIcon,
  Eye as EyeIcon,
  EyeOff as EyeOffIcon,
  GripVertical as GripIcon,
  RotateCcw as ResetIcon,
} from "lucide-react";
import { Button } from "../Button";
import { useKey } from "../../lib/keybindings";
import { boardCellStyle } from "./Board";
import type { BoardCell } from "./boardLayout";
import {
  DEFAULT_ARRANGEMENT,
  HOME_PANELS,
  HOME_PANEL_TITLES,
  isDefaultArrangement,
  setPanelHidden,
  swapPanels,
  type HomeArrangement,
  type HomePanelId,
} from "./homeArrangement";

/**
 * Customizing Home: while editing, every panel turns into a tile to drag
 * onto another (they swap slots) or to hide, and a bar above the board
 * lists hidden panels, Reset and Done. Move, then Swap here on another
 * panel, does the same as a drag, from the keyboard or a touch screen.
 */

/** The morph running now, and the slots it lifted. */
let activeMorph: { lifted: HTMLElement[] } | null = null;

/**
 * Runs a change to the board as a view transition, so panels glide to their
 * new slots. The `lift` panels (two being swapped) travel above the rest
 * rather than passing under them.
 */
function morphBoard(update: () => void, lift: HomePanelId[] = []) {
  if (
    typeof document.startViewTransition !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    update();
    return;
  }
  const root = document.documentElement;
  const lifted = lift.flatMap((id) => [...document.querySelectorAll<HTMLElement>(`.board-slot[data-panel="${id}"]`)]);
  // A morph still running is skipped by this one; its panels settle back
  // down unless this one lifts them too. Its own cleanup runs too late:
  // after this morph has captured its starting frame.
  for (const el of activeMorph?.lifted ?? []) if (!lifted.includes(el)) delete el.dataset.lift;
  const morph = { lifted };
  activeMorph = morph;
  root.dataset.boardMorph = "";
  for (const el of lifted) el.dataset.lift = "";
  const transition = document.startViewTransition(update);
  // A skipped transition rejects `ready`, but its update still runs.
  transition.ready.catch(() => {});
  void transition.finished
    .catch(() => {})
    .finally(() => {
      if (activeMorph !== morph) return;
      activeMorph = null;
      for (const el of lifted) delete el.dataset.lift;
      delete root.dataset.boardMorph;
    });
}

/** What a slot needs while customizing: its state, drag handlers and tile. */
export interface SlotEditing {
  dragging: boolean;
  /** A drag is over it. */
  target: boolean;
  /** Picked with Move. */
  moving: boolean;
  onDragStart: DragEventHandler<HTMLElement>;
  onDragEnter: DragEventHandler<HTMLElement>;
  onDragOver: DragEventHandler<HTMLElement>;
  onDragLeave: DragEventHandler<HTMLElement>;
  onDrop: DragEventHandler<HTMLElement>;
  onDragEnd: DragEventHandler<HTMLElement>;
  editor: ReactNode;
}

export function useBoardEditor({
  editing,
  arrangement,
  onChange,
  onDone,
}: {
  editing: boolean;
  arrangement: HomeArrangement;
  onChange: (next: HomeArrangement) => void;
  onDone: () => void;
}) {
  // Picked with Move, waiting for Swap here.
  const [moving, setMoving] = useState<HomePanelId | null>(null);
  const [dragging, setDragging] = useState<HomePanelId | null>(null);
  const [target, setTarget] = useState<HomePanelId | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // The drag source, for dragover before the deferred state lands.
  const dragSource = useRef<HomePanelId | null>(null);
  // Drag enters minus leaves per slot, counting its children. A leave
  // can't be told apart by relatedTarget: Safari leaves it null.
  const dragDepth = useRef(new Map<HomePanelId, number>());
  const moveButtons = useRef(new Map<HomePanelId, HTMLButtonElement>());
  const doneButton = useRef<HTMLButtonElement>(null);
  if (!editing && (moving || dragging || target || announcement)) {
    setMoving(null);
    setDragging(null);
    setTarget(null);
    setAnnouncement("");
  }

  /** Applies a change, then focuses what `focus` names once it's on the board. */
  const change = (next: HomeArrangement, message: string, focus?: HomePanelId | "done", lift?: HomePanelId[]) => {
    setMoving(null);
    morphBoard(() => {
      flushSync(() => onChange(next));
      if (focus === "done") doneButton.current?.focus();
      else if (focus) moveButtons.current.get(focus)?.focus({ preventScroll: true });
    }, lift);
    setAnnouncement(message);
  };

  const endDrag = () => {
    dragSource.current = null;
    dragDepth.current.clear();
    setDragging(null);
    setTarget(null);
  };

  const swap = (from: HomePanelId, to: HomePanelId, focus?: HomePanelId) => {
    if (from === to) return;
    change(
      swapPanels(arrangement, from, to),
      `Swapped ${HOME_PANEL_TITLES[from]} and ${HOME_PANEL_TITLES[to]}.`,
      focus,
      [from, to],
    );
  };

  const hide = (id: HomePanelId, focusNext: HomePanelId | undefined) =>
    change(setPanelHidden(arrangement, id, true), `${HOME_PANEL_TITLES[id]} hidden.`, focusNext ?? "done");

  // Show, hide, swap and reset all end a pending Move (in `change`), so the
  // panel they focus has its Move button, not Swap here.
  const show = (id: HomePanelId) =>
    change(setPanelHidden(arrangement, id, false), `${HOME_PANEL_TITLES[id]} shown.`, id);

  // Leaving hands focus to the top bar's Customize button, where editing
  // started, rather than dropping it with the bar.
  const done = () => {
    setMoving(null);
    const trigger = document.querySelector<HTMLElement>("[data-customize-trigger]");
    if (trigger?.checkVisibility?.()) trigger.focus();
    onDone();
  };

  const reset = () => {
    setMoving(null);
    if (isDefaultArrangement(arrangement)) return;
    change(DEFAULT_ARRANGEMENT, "Home is back to its default layout.", "done");
  };

  useKey(
    "esc",
    () => {
      if (moving) {
        moveButtons.current.get(moving)?.focus();
        setMoving(null);
      } else {
        done();
      }
    },
    { id: "home:customize", enabled: editing },
  );

  /** What a slot needs while editing: its drag handlers and its tile. */
  const slot = (id: HomePanelId, next: HomePanelId | undefined, empty: boolean): SlotEditing => ({
    dragging: dragging === id,
    target: target === id,
    moving: moving === id,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.dataTransfer.effectAllowed = "move";
      // Firefox only starts a drag that carries data.
      e.dataTransfer.setData("text/plain", HOME_PANEL_TITLES[id]);
      dragSource.current = id;
      setMoving(null);
      // Restyling the source in dragstart can cancel the drag in Chrome.
      requestAnimationFrame(() => setDragging(dragSource.current));
    },
    onDragEnter: () => {
      const from = dragSource.current;
      if (!from || from === id) return;
      dragDepth.current.set(id, (dragDepth.current.get(id) ?? 0) + 1);
      setTarget(id);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      const from = dragSource.current;
      if (!from || from === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    onDragLeave: () => {
      const depth = (dragDepth.current.get(id) ?? 0) - 1;
      if (depth > 0) {
        dragDepth.current.set(id, depth);
        return;
      }
      dragDepth.current.delete(id);
      setTarget((t) => (t === id ? null : t));
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      const from = dragSource.current;
      endDrag();
      if (from) swap(from, id);
    },
    onDragEnd: endDrag,
    editor: (
      <SlotEditor
        id={id}
        title={HOME_PANEL_TITLES[id]}
        empty={empty}
        state={moving === id ? "moving" : moving ? "target" : "idle"}
        moveRef={(el) => {
          if (el) moveButtons.current.set(id, el);
          else moveButtons.current.delete(id);
        }}
        onMove={() => {
          setMoving(id);
          setAnnouncement(`Moving ${HOME_PANEL_TITLES[id]}. Choose Swap here on another panel, or press Escape to cancel.`);
        }}
        onCancel={() => setMoving(null)}
        onSwapHere={() => moving && swap(moving, id, moving)}
        onHide={() => hide(id, next)}
      />
    ),
  });

  const bar = (
    <BoardEditBar
      arrangement={arrangement}
      moving={moving}
      announcement={announcement}
      doneRef={doneButton}
      onShow={show}
      onReset={reset}
      onDone={done}
    />
  );

  return { slot, bar };
}

/**
 * A grid cell of the board: the panel, and while editing a tile over it
 * that drags and holds Move and Hide. The panel underneath goes inert, so
 * nothing in it plays or opens mid-arrangement.
 */
export function BoardSlot({
  cell,
  panel,
  editing,
  children,
}: {
  cell: BoardCell;
  panel: HomePanelId;
  editing: SlotEditing | null;
  children: ReactNode;
}) {
  return (
    <div
      className="board-slot"
      style={{
        ...boardCellStyle(cell),
        // Named only while editing, so other view transitions (the mini
        // player's) don't pick the board's panels out.
        viewTransitionName: editing ? `board-${panel}` : undefined,
      }}
      data-panel={panel}
      data-slot={cell.id}
      data-editing={editing ? "" : undefined}
      data-dragging={editing?.dragging || undefined}
      data-target={editing?.target || undefined}
      data-moving={editing?.moving || undefined}
      draggable={editing ? true : undefined}
      onDragStart={editing?.onDragStart}
      onDragEnter={editing?.onDragEnter}
      onDragOver={editing?.onDragOver}
      onDragLeave={editing?.onDragLeave}
      onDrop={editing?.onDrop}
      onDragEnd={editing?.onDragEnd}
    >
      <div className="board-slot-body" inert={editing ? "" : undefined}>
        {children}
      </div>
      {editing?.editor}
    </div>
  );
}

function SlotEditor({
  id,
  title,
  empty,
  state,
  moveRef,
  onMove,
  onCancel,
  onSwapHere,
  onHide,
}: {
  id: HomePanelId;
  title: string;
  /** Has nothing to show right now, so it's off the board outside editing. */
  empty: boolean;
  /** Idle, picked with Move, or a place the picked panel can go. */
  state: "idle" | "moving" | "target";
  moveRef: (el: HTMLButtonElement | null) => void;
  onMove: () => void;
  onCancel: () => void;
  onSwapHere: () => void;
  onHide: () => void;
}) {
  return (
    <div className="board-slot-editor" role="group" aria-label={title}>
      {/* Its own view transition group, so it glides to the middle of the
          panel's new place rather than fading between two spots. */}
      <div className="board-slot-label" style={{ viewTransitionName: `board-label-${id}` }}>
        <GripIcon className="board-slot-grip size-4" aria-hidden="true" />
        <div className="board-slot-name">{title}</div>
        {empty && <div className="board-slot-note">Shows up once it has something</div>}
        <div className="board-slot-actions">
          {state === "target" ? (
            <Button size="sm" variant="primary" onClick={onSwapHere} leadingIcon={<SwapIcon className="size-3.5" />}>
              Swap here<span className="sr-only"> with {title}</span>
            </Button>
          ) : (
            <Button
              ref={moveRef}
              size="sm"
              aria-pressed={state === "moving"}
              onClick={state === "moving" ? onCancel : onMove}
              leadingIcon={<SwapIcon className="size-3.5" />}
            >
              {state === "moving" ? "Cancel move" : "Move"}
              <span className="sr-only"> {title}</span>
            </Button>
          )}
          {state !== "moving" && (
            <Button size="sm" variant="ghost" onClick={onHide} leadingIcon={<EyeOffIcon className="size-3.5" />}>
              Hide<span className="sr-only"> {title}</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function BoardEditBar({
  arrangement,
  moving,
  announcement,
  doneRef,
  onShow,
  onReset,
  onDone,
}: {
  arrangement: HomeArrangement;
  moving: HomePanelId | null;
  announcement: string;
  doneRef: RefObject<HTMLButtonElement>;
  onShow: (id: HomePanelId) => void;
  onReset: () => void;
  onDone: () => void;
}) {
  const hidden = HOME_PANELS.filter((id) => arrangement.hidden.has(id));
  return (
    <div className="board-editbar" role="region" aria-label="Customize Home">
      <div className="board-editbar-text">
        <h2 className="board-editbar-title">Customize Home</h2>
        <p className="board-editbar-hint">
          {moving
            ? `Choose where ${HOME_PANEL_TITLES[moving]} goes.`
            : "Drag a panel onto another to swap them."}
        </p>
      </div>
      {hidden.length > 0 && (
        <div className="board-editbar-hidden" role="group" aria-label="Hidden panels">
          <span className="board-editbar-label">Hidden</span>
          {hidden.map((id) => (
            <Button
              key={id}
              size="sm"
              onClick={() => onShow(id)}
              aria-label={`Show ${HOME_PANEL_TITLES[id]}`}
              leadingIcon={<EyeIcon className="size-3.5" />}
            >
              {HOME_PANEL_TITLES[id]}
            </Button>
          ))}
        </div>
      )}
      <div className="board-editbar-actions">
        <Button
          size="sm"
          variant="ghost"
          onClick={onReset}
          // Not disabled: a disabled button drops the focus it had.
          aria-disabled={isDefaultArrangement(arrangement) || undefined}
          leadingIcon={<ResetIcon className="size-3.5" />}
        >
          Reset
        </Button>
        <Button ref={doneRef} size="sm" variant="primary" onClick={onDone} leadingIcon={<CheckIcon className="size-3.5" />}>
          Done
        </Button>
      </div>
      <div className="sr-only" role="status">
        {announcement}
      </div>
    </div>
  );
}
