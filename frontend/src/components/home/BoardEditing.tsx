import { useEffect, useRef, useState, type DragEvent, type DragEventHandler, type ReactNode, type RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import {
  ArrowLeftRight as SwapIcon,
  Check as CheckIcon,
  Eye as EyeIcon,
  EyeOff as EyeOffIcon,
  GripVertical as GripIcon,
  Plus as PlusIcon,
  RotateCcw as ResetIcon,
  SlidersHorizontal as EditIcon,
} from "lucide-react";
import type { Playlist } from "../../api";
import { Button } from "../Button";
import { useKey } from "../../lib/keybindings";
import { boardCellStyle } from "./Board";
import type { BoardCell } from "./boardLayout";
import { AddPanelDialog, PanelSettingsDialog, ResetBoardDialog } from "./BoardDialogs";
import {
  DEFAULT_ARRANGEMENT,
  DEFAULT_PANEL_IDS,
  addPanel,
  findPanel,
  isDefaultArrangement,
  panelTitle,
  removePanel,
  setPanelHidden,
  swapPanels,
  updatePanel,
  type HomeArrangement,
  type HomePanel,
  type HomePanelId,
  type PanelChange,
} from "./homeArrangement";
import { PANEL_KINDS, periodSub, type PanelKind } from "./panelKinds";

/**
 * Customizing Home: while editing, every panel turns into a tile to drag
 * onto another (they swap places), to edit (its size, name and what it
 * shows) or to hide, and a bar above the board lists hidden panels, Add
 * panel, Reset and Done. Move, then Swap here on another panel, does the
 * same as a drag, from the keyboard or a touch screen.
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
  playlists,
  years,
  onChange,
  onDone,
}: {
  editing: boolean;
  arrangement: HomeArrangement;
  /** For playlist panels' names and the playlists they can show; null until loaded. */
  playlists: readonly Playlist[] | null;
  /** Past years with plays, for period panels to show. */
  years: readonly number[];
  onChange: (next: HomeArrangement) => void;
  onDone: () => void;
}) {
  const titleOf = (panel: HomePanel | undefined) => (panel ? panelTitle(panel, playlists) : "");
  /**
   * A panel's name for screen readers and announcements: with its period,
   * so two On repeats tell apart without the line under the name.
   */
  const labelOf = (panel: HomePanel | undefined) =>
    panel && PANEL_KINDS[panel.kind].period ? `${titleOf(panel)} (${periodSub(panel.period)})` : titleOf(panel);
  const labelById = (id: HomePanelId) => labelOf(findPanel(latest.current, id) ?? findPanel(arrangement, id));
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
  // The open dialog: Add panel, a panel's settings (and where focus goes if
  // it's removed), or Reset's confirmation.
  const [dialog, setDialog] = useState<
    { kind: "add" } | { kind: "settings"; id: HomePanelId; next: HomePanelId | undefined } | { kind: "reset" } | null
  >(null);
  if (!editing && (moving || dragging || target || announcement || dialog)) {
    setMoving(null);
    setDragging(null);
    setTarget(null);
    setAnnouncement("");
    setDialog(null);
  }

  // The arrangement the last change left. A view transition runs its update
  // a frame later, so a change made in between (two quick Hides) builds on
  // the one before it, not on this render's arrangement, or it would undo it.
  const latest = useRef(arrangement);
  useEffect(() => {
    latest.current = arrangement;
  }, [arrangement]);

  /**
   * Applies a change, then focuses what `focus` names once it's on the
   * board, scrolling to it when `reveal` (a panel just added at the end).
   */
  const change = (
    update: (current: HomeArrangement) => HomeArrangement,
    message: string,
    focus?: HomePanelId | "done",
    {
      lift,
      reveal = false,
      instant = false,
    }: {
      lift?: HomePanelId[];
      reveal?: boolean;
      /** From a dialog: the panels' morph would run over it as it closes. */
      instant?: boolean;
    } = {},
  ) => {
    setMoving(null);
    const apply = () => {
      const next = update(latest.current);
      latest.current = next;
      flushSync(() => onChange(next));
      if (focus === "done") doneButton.current?.focus();
      else if (focus) {
        const button = moveButtons.current.get(focus);
        button?.focus({ preventScroll: true });
        if (reveal) button?.closest(".board-slot")?.scrollIntoView?.({ block: "nearest" });
      }
    };
    if (instant) apply();
    else morphBoard(apply, lift);
    setAnnouncement(message);
  };

  /**
   * A change from a panel's settings: no morph, which would run over the
   * dialog. Each is one interaction, so the next builds on its render.
   */
  const changeNow = (id: HomePanelId, panelChange: PanelChange) => onChange(updatePanel(latest.current, id, panelChange));

  const endDrag = () => {
    dragSource.current = null;
    dragDepth.current.clear();
    setDragging(null);
    setTarget(null);
  };

  const swap = (from: HomePanelId, to: HomePanelId, focus?: HomePanelId) => {
    if (from === to) return;
    change(
      (current) => swapPanels(current, from, to),
      `Swapped ${labelById(from)} and ${labelById(to)}.`,
      focus,
      { lift: [from, to] },
    );
  };

  const hide = (id: HomePanelId, focusNext: HomePanelId | undefined) =>
    change((current) => setPanelHidden(current, id, true), `${labelById(id)} hidden.`, focusNext ?? "done");

  // Show, hide, swap, add, remove and reset all end a pending Move (in
  // `change`), so the panel they focus has its Move button, not Swap here.
  const show = (id: HomePanelId) =>
    change((current) => setPanelHidden(current, id, false), `${labelById(id)} shown.`, id);

  const add = (kind: PanelKind, options: Pick<HomePanel, "period" | "playlist">) => {
    setDialog(null);
    const { arrangement: next, id } = addPanel(latest.current, kind, options);
    if (!id) return;
    const panel = findPanel(next, id)!;
    const shownAgain = !!findPanel(latest.current, id);
    change(
      (current) => addPanel(current, kind, options).arrangement,
      `${labelOf(panel)} ${shownAgain ? "shown" : "added"}.`,
      id,
      { reveal: true, instant: true },
    );
  };

  const remove = (id: HomePanelId, focusNext: HomePanelId | undefined) => {
    const title = labelById(id);
    setDialog(null);
    change((current) => removePanel(current, id), `${title} removed.`, focusNext ?? "done", { instant: true });
  };

  // Leaving hands focus to the top bar's Customize button, where editing
  // started, rather than dropping it with the bar.
  const done = () => {
    setMoving(null);
    const trigger = document.querySelector<HTMLElement>("[data-customize-trigger]");
    if (trigger?.checkVisibility?.()) trigger.focus();
    onDone();
  };

  // Panels the user added are lost to a reset, so that asks first.
  const added = arrangement.panels.filter((panel) => !(DEFAULT_PANEL_IDS as readonly string[]).includes(panel.id));
  const resetNow = () => {
    setDialog(null);
    change(() => DEFAULT_ARRANGEMENT, "Home is back to its default layout.", "done", { instant: dialog !== null });
  };
  const reset = () => {
    setMoving(null);
    if (isDefaultArrangement(arrangement)) return;
    if (added.length > 0) setDialog({ kind: "reset" });
    else resetNow();
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
    // A dialog answers Escape itself.
    { id: "home:customize", enabled: editing && !dialog },
  );

  /** What a slot needs while editing: its drag handlers and its tile. */
  const slot = (panel: HomePanel, next: HomePanelId | undefined, note: string | null): SlotEditing => {
    const { id } = panel;
    const title = titleOf(panel);
    const label = labelOf(panel);
    return {
      dragging: dragging === id,
      target: target === id,
      moving: moving === id,
      onDragStart: (e: DragEvent<HTMLElement>) => {
        e.dataTransfer.effectAllowed = "move";
        // Firefox only starts a drag that carries data.
        e.dataTransfer.setData("text/plain", title);
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
          title={title}
          label={label}
          detail={PANEL_KINDS[panel.kind].period ? periodSub(panel.period) : undefined}
          note={note}
          state={moving === id ? "moving" : moving ? "target" : "idle"}
          moveRef={(el) => {
            if (el) moveButtons.current.set(id, el);
            else moveButtons.current.delete(id);
          }}
          onMove={() => {
            setMoving(id);
            setAnnouncement(`Moving ${label}. Choose Swap here on another panel, or press Escape to cancel.`);
          }}
          onCancel={() => setMoving(null)}
          onSwapHere={() => moving && swap(moving, id, moving)}
          onEdit={() => {
            setMoving(null);
            setDialog({ kind: "settings", id, next });
          }}
          onHide={() => hide(id, next)}
        />
      ),
    };
  };

  const bar = (
    <BoardEditBar
      arrangement={arrangement}
      labelOf={labelOf}
      moving={moving && labelOf(findPanel(arrangement, moving))}
      announcement={announcement}
      doneRef={doneButton}
      onShow={show}
      onAdd={() => {
        setMoving(null);
        setDialog({ kind: "add" });
      }}
      onReset={reset}
      onDone={done}
    />
  );

  const settingsPanel = dialog?.kind === "settings" ? findPanel(arrangement, dialog.id) : undefined;
  // On the body, over the app, like the app-wide dialogs, rather than in
  // the board's scrolling page.
  const dialogs = editing && createPortal(
    <>
      <AddPanelDialog
        open={dialog?.kind === "add"}
        arrangement={arrangement}
        playlists={playlists}
        years={years}
        onAdd={add}
        onClose={() => setDialog(null)}
      />
      <PanelSettingsDialog
        open={!!settingsPanel}
        panel={settingsPanel}
        title={titleOf(settingsPanel)}
        playlists={playlists}
        years={years}
        onChange={(panelChange) => settingsPanel && changeNow(settingsPanel.id, panelChange)}
        onRemove={() => dialog?.kind === "settings" && remove(dialog.id, dialog.next)}
        onClose={() => setDialog(null)}
      />
      <ResetBoardDialog
        open={dialog?.kind === "reset"}
        added={added.map((panel) => labelOf(panel))}
        onReset={resetNow}
        onClose={() => setDialog(null)}
      />
    </>,
    document.body,
  );

  return { slot, bar, dialogs };
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
  label,
  detail,
  note,
  state,
  moveRef,
  onMove,
  onCancel,
  onSwapHere,
  onEdit,
  onHide,
}: {
  id: HomePanelId;
  title: string;
  /** Its name for screen readers, which tells two of a kind apart. */
  label: string;
  /** What it shows, when there's a choice (a period). */
  detail?: string;
  /** Why it's off the board outside customizing (nothing to show yet), if it is. */
  note: string | null;
  /** Idle, picked with Move, or a place the picked panel can go. */
  state: "idle" | "moving" | "target";
  moveRef: (el: HTMLButtonElement | null) => void;
  onMove: () => void;
  onCancel: () => void;
  onSwapHere: () => void;
  onEdit: () => void;
  onHide: () => void;
}) {
  return (
    <div className="board-slot-editor" role="group" aria-label={label}>
      {/* Its own view transition group, so it glides to the middle of the
          panel's new place rather than fading between two spots. */}
      <div className="board-slot-label" style={{ viewTransitionName: `board-label-${id}` }}>
        <GripIcon className="board-slot-grip size-4" aria-hidden="true" />
        <div className="board-slot-name">{title}</div>
        {detail && <div className="board-slot-note">{detail}</div>}
        {note && <div className="board-slot-note">{note}</div>}
        <div className="board-slot-actions">
          {state === "target" ? (
            <Button size="sm" variant="primary" onClick={onSwapHere} leadingIcon={<SwapIcon className="size-3.5" />}>
              Swap here<span className="sr-only"> with {label}</span>
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
              <span className="sr-only"> {label}</span>
            </Button>
          )}
          {state === "idle" && (
            <Button size="sm" onClick={onEdit} leadingIcon={<EditIcon className="size-3.5" />}>
              Edit<span className="sr-only"> {label}</span>
            </Button>
          )}
          {state !== "moving" && (
            <Button size="sm" variant="ghost" onClick={onHide} leadingIcon={<EyeOffIcon className="size-3.5" />}>
              Hide<span className="sr-only"> {label}</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function BoardEditBar({
  arrangement,
  labelOf,
  moving,
  announcement,
  doneRef,
  onShow,
  onAdd,
  onReset,
  onDone,
}: {
  arrangement: HomeArrangement;
  labelOf: (panel: HomePanel) => string;
  /** The name of the panel picked with Move. */
  moving: string | null;
  announcement: string;
  doneRef: RefObject<HTMLButtonElement>;
  onShow: (id: HomePanelId) => void;
  onAdd: () => void;
  onReset: () => void;
  onDone: () => void;
}) {
  const hidden = arrangement.panels.filter((panel) => panel.hidden);
  return (
    <div className="board-editbar" role="region" aria-label="Customize Home">
      <div className="board-editbar-text">
        <h2 className="board-editbar-title">Customize Home</h2>
        <p className="board-editbar-hint">
          {moving
            ? `Choose where ${moving} goes.`
            : "Drag a panel onto another to swap them, or edit one to change its size and what it shows."}
        </p>
      </div>
      {hidden.length > 0 && (
        <div className="board-editbar-hidden" role="group" aria-label="Hidden panels">
          <span className="board-editbar-label">Hidden</span>
          {hidden.map((panel) => (
            <Button
              key={panel.id}
              size="sm"
              onClick={() => onShow(panel.id)}
              aria-label={`Show ${labelOf(panel)}`}
              leadingIcon={<EyeIcon className="size-3.5" />}
            >
              {labelOf(panel)}
            </Button>
          ))}
        </div>
      )}
      <div className="board-editbar-actions">
        <Button size="sm" onClick={onAdd} leadingIcon={<PlusIcon className="size-3.5" />}>
          Add panel
        </Button>
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
