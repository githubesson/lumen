import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { MiniPlayerPanelAnchor } from "../../electron";
import { useLyricsPanel } from "../../context/LyricsPanel";
import {
  canSetMiniPlayer,
  getMiniPlayerPanelAnchor,
  setMiniPlayerMode as setElectronMiniPlayer,
  setMiniPlayerPanel,
} from "../../lib/platform";

/** What the mini player's side panel can show, in utility-row order. */
export const MINI_PANELS = ["devices", "lyrics", "queue"] as const;
export type MiniPanel = (typeof MINI_PANELS)[number];

export const MINI_PANEL_ID = "mini-player-panel";

/** Props for a utility button that toggles one of the panels. */
export interface MiniPanelToggle {
  open: boolean;
  controls: string;
  onToggle: () => void;
}

/**
 * Open state for a utility button's popover. It closes whenever the button
 * switches between its popover and the mini player's panel, so a popover
 * left open (entering mini mode from the keyboard is no outside click)
 * doesn't come back on its own after mini mode.
 */
export function usePopoverOpen(panelMode: boolean) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(panelMode);
  if (mode !== panelMode) {
    setMode(panelMode);
    setOpen(false);
  }
  return [open, setOpen] as const;
}

/**
 * Desktop mini player window mode. Mirrors the mode onto
 * `<html data-mini-player>` and closes the lyrics panel while it is on.
 *
 * It also owns the mini player's panel (queue, lyrics or devices). Opening
 * one grows the window, then morphs the bar into two columns with a view
 * transition; closing runs the morph backwards and shrinks the window after.
 * Requests are queued and settled one step at a time, so rapid clicks can't
 * overlap two resizes or two transitions.
 */
export function useMiniPlayerMode() {
  const { open: lyricsOpen, setOpen: setLyricsOpen } = useLyricsPanel();
  const [miniPlayerMode, setMiniPlayerMode] = useState(false);
  // What the layout shows, and what the user last asked for; they differ
  // while the window resizes or a morph runs.
  const [panel, setPanel] = useState<MiniPanel | null>(null);
  const [requested, setRequested] = useState<MiniPanel | null>(null);
  const [swapDirection, setSwapDirection] = useState<"forward" | "back">();
  const [anchor, setAnchorState] = useState<MiniPlayerPanelAnchor>("top");
  const anchorRef = useRef<MiniPlayerPanelAnchor>("top");
  const setAnchor = useCallback((next: MiniPlayerPanelAnchor) => {
    anchorRef.current = next;
    setAnchorState(next);
  }, []);
  // The bar's own height, measured before the window first grows: it keeps
  // that height while the window around it is taller than it.
  const [barHeight, setBarHeight] = useState<number>();

  const wanted = useRef<MiniPanel | null>(null);
  const shown = useRef<MiniPanel | null>(null);
  const instantClose = useRef(false);
  // Bumped when mini mode ends. A settle from an older session touches no
  // state after its next await, and doesn't block the new session's own.
  const session = useRef(0);
  const settlingSession = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.toggleAttribute(
      "data-mini-player",
      miniPlayerMode,
    );
    return () => {
      document.documentElement.removeAttribute("data-mini-player");
    };
  }, [miniPlayerMode]);

  useEffect(() => {
    if (miniPlayerMode && lyricsOpen) {
      setLyricsOpen(false);
    }
  }, [miniPlayerMode, lyricsOpen, setLyricsOpen]);

  const settle = useCallback(async () => {
    const id = session.current;
    if (settlingSession.current === id) return;
    settlingSession.current = id;
    const live = () => id === session.current;
    try {
      while (live() && wanted.current !== shown.current) {
        const from = shown.current;
        const to = wanted.current;
        if (from && to) {
          setSwapDirection(
            MINI_PANELS.indexOf(to) > MINI_PANELS.indexOf(from)
              ? "forward"
              : "back",
          );
          setPanel(to);
          shown.current = to;
        } else if (to) {
          const collapsedHeight = window.innerHeight;
          const planned = await getMiniPlayerPanelAnchor();
          if (!live()) return;
          // Pin the bar to the edge that stays put before the window grows.
          flushSync(() => {
            setBarHeight(collapsedHeight);
            setAnchor(planned);
          });
          const result = await setMiniPlayerPanel(true);
          if (!live()) return;
          if (!result.ok) {
            wanted.current = null;
            setRequested(null);
            break;
          }
          if (result.anchor !== planned) {
            flushSync(() => setAnchor(result.anchor));
          }
          await viewportResize(collapsedHeight);
          if (!live()) return;
          await morph("open", anchorRef.current, () => {
            // The update runs a frame after the call; mini mode may be gone.
            if (!live()) return;
            setSwapDirection(undefined);
            setPanel(to);
          });
          if (!live()) return;
          shown.current = to;
        } else {
          const instant = instantClose.current;
          instantClose.current = false;
          await morph(instant ? null : "close", anchorRef.current, () => {
            if (live()) setPanel(null);
          });
          if (!live()) return;
          shown.current = null;
          await setMiniPlayerPanel(false);
        }
      }
    } finally {
      if (settlingSession.current === id) settlingSession.current = null;
    }
  }, [setAnchor]);

  const requestPanel = useCallback(
    (next: MiniPanel | null, opts?: { instant?: boolean }) => {
      wanted.current = next;
      instantClose.current = next === null && !!opts?.instant;
      setRequested(next);
      void settle();
    },
    [settle],
  );

  const togglePanel = useCallback(
    (which: MiniPanel) =>
      requestPanel(wanted.current === which ? null : which),
    [requestPanel],
  );

  const panelToggle = (which: MiniPanel): MiniPanelToggle => ({
    open: requested === which,
    controls: MINI_PANEL_ID,
    onToggle: () => togglePanel(which),
  });

  // Escape closes the panel, without the morph: a keyboard dismissal should
  // be instant. An open context menu gets the key first.
  useEffect(() => {
    if (!miniPlayerMode || !requested) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".ctx-menu")) return;
      requestPanel(null, { instant: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [miniPlayerMode, requested, requestPanel]);

  const toggleMiniPlayerMode = async () => {
    if (!canSetMiniPlayer()) return;
    const next = !miniPlayerMode;
    if (!next) {
      // Leaving mini mode restores the normal window whatever the panel was
      // doing; drop the panel on the spot.
      session.current += 1;
      wanted.current = null;
      shown.current = null;
      setPanel(null);
      setRequested(null);
      setBarHeight(undefined);
      setAnchor("top");
    }
    setMiniPlayerMode(next);
    const result = await setElectronMiniPlayer(next);
    if (!result.ok || result.miniPlayer !== next) {
      setMiniPlayerMode(result.miniPlayer);
    }
  };

  return {
    miniPlayerMode,
    toggleMiniPlayerMode,
    panel,
    swapDirection,
    anchor,
    barHeight,
    panelToggle,
  };
}

// The latest morph; an older one that settles late (a new one skips it)
// mustn't clear the attributes the new one's transition is using.
let activeMorph: object | null = null;

/**
 * Runs a layout change as a view transition; the mini player CSS picks the
 * choreography from `<html data-mini-morph data-mini-morph-anchor>`. With no
 * `kind`, or no view transition support, the change just happens.
 */
async function morph(
  kind: "open" | "close" | null,
  anchor: MiniPlayerPanelAnchor,
  update: () => void,
) {
  if (!kind || typeof document.startViewTransition !== "function") {
    flushSync(update);
    return;
  }
  const root = document.documentElement;
  const token = {};
  activeMorph = token;
  root.dataset.miniMorph = kind;
  root.dataset.miniMorphAnchor = anchor;
  try {
    const transition = document.startViewTransition(() => flushSync(update));
    // A skipped transition rejects `ready`, but its update still runs and
    // `finished` still settles.
    transition.ready.catch(() => {});
    await transition.finished;
  } catch {
    // The update itself threw; nothing left to animate.
  } finally {
    if (activeMorph === token) {
      activeMorph = null;
      delete root.dataset.miniMorph;
      delete root.dataset.miniMorphAnchor;
    }
  }
}

/**
 * Resolves once the viewport is no longer `fromHeight` tall (the window
 * resize has reached this renderer), or after a timeout. A view transition
 * started before that would be skipped by the resize.
 */
function viewportResize(fromHeight: number, timeoutMs = 400): Promise<void> {
  return new Promise((resolve) => {
    if (window.innerHeight !== fromHeight) {
      resolve();
      return;
    }
    const done = () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(timer);
      resolve();
    };
    const onResize = () => {
      if (window.innerHeight !== fromHeight) done();
    };
    const timer = window.setTimeout(done, timeoutMs);
    window.addEventListener("resize", onResize);
  });
}
