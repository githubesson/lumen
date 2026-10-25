import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { X as XMarkIcon } from "lucide-react";
import { FocusScope } from "@radix-ui/react-focus-scope";
import { trapTab } from "../lib/focusTrap";
import { useModalKeyScope } from "../lib/keybindings";
import { useTransitionMount } from "../lib/useTransitionMount";

// Open dialogs, innermost last. Only the innermost one answers Escape and Tab,
// so a dialog opened from another closes first.
const openDialogs: object[] = [];

/**
 * Shared modal scaffold: scrim + mount/exit transition + header with close
 * button + Escape-to-close. Promoted out of EditDialog so UploadDialog and the
 * playlist dialogs (which hand-rolled their own scaffold and dropped
 * Escape-to-close) can reuse it. While open it holds focus (Tab cycles inside,
 * page shortcuts pause) and gives it back to the opener on close. Pass the
 * scrollable body as `children` and an optional sticky `footer`. Without a
 * `title` there's no header bar, and `labelledBy` names the heading inside.
 */
export function DialogShell({
  open,
  title,
  labelledBy,
  describedBy,
  role = "dialog",
  initialFocus,
  onClose,
  children,
  footer,
  maxWidth,
}: {
  open: boolean;
  /** The header bar's title; leave it out for a dialog without one. */
  title?: ReactNode;
  /** Without a title, the id of the heading inside that names the dialog. */
  labelledBy?: string;
  describedBy?: string;
  /** "alertdialog" for a question that interrupts, like a confirmation. */
  role?: "dialog" | "alertdialog";
  /** Takes focus on open, instead of the panel. */
  initialFocus?: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Override the default max width (defaults to max-w-lg). */
  maxWidth?: number | string;
}) {
  const titleId = useId();
  const { mounted, visible } = useTransitionMount(open, 200);
  // Keys and focus belong to the dialog only while it's open. During the exit
  // fade it's still mounted, but they already go back to the page.
  const interactive = open && mounted;
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Callers pass a fresh arrow each render; the effect below must only run as
  // the dialog opens and closes, or it would pull focus back every render.
  const latestClose = useRef(onClose);
  const latestInitialFocus = useRef(initialFocus);
  useEffect(() => {
    latestClose.current = onClose;
    latestInitialFocus.current = initialFocus;
  });

  useEffect(() => {
    if (!interactive) return;
    const token = {};
    openDialogs.push(token);
    const restoreTo = document.activeElement as HTMLElement | null;
    const layer = layerRef.current;
    const panel = panelRef.current;
    // An autoFocus field already has focus. Otherwise start on the chosen
    // control, or the panel, so the first Tab lands on the first control.
    if (!panel?.contains(document.activeElement)) {
      (latestInitialFocus.current?.current ?? panel)?.focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== token) return;
      // An open Select's Tab carries on from its trigger, so it's trapped too.
      if (event.key === "Tab") {
        trapTab(event, panel);
        return;
      }
      // An open Select owns Escape until it closes, as does a control that
      // cancels something of its own with it (data-owns-escape).
      if (
        event.target instanceof Element &&
        event.target.closest('[role="listbox"], [data-owns-escape]')
      ) {
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      latestClose.current();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      openDialogs.splice(openDialogs.indexOf(token), 1);
      // Hand focus back to whatever opened the dialog, unless something else
      // (another dialog, the command palette) has already taken it.
      const now = document.activeElement;
      if (!now || now === document.body || layer?.contains(now)) {
        if (restoreTo?.isConnected) restoreTo.focus();
      }
    };
  }, [interactive]);
  useModalKeyScope(interactive);

  // Radix pauses its focus traps under the newest FocusScope. This one mounts
  // as the dialog opens, a frame before the panel, so a Radix modal beneath
  // (the command palette) stops pulling focus back out of the dialog, which
  // would also leave Enter running the palette's highlighted item. Focus
  // itself stays with the effect above.
  const radixPause = open && (
    <FocusScope
      hidden
      onMountAutoFocus={(event) => {
        event.preventDefault();
        // Mounted already open, the panel took focus before the pause, and
        // the trap took it back: take it again.
        const panel = panelRef.current;
        if (panel && !panel.contains(document.activeElement)) {
          (latestInitialFocus.current?.current ?? panel).focus();
        }
      }}
      onUnmountAutoFocus={(event) => event.preventDefault()}
    />
  );

  return (
    <>
      {radixPause}
      {mounted && (
        <div
          ref={layerRef}
          role={role}
          aria-modal="true"
          aria-labelledby={title ? titleId : labelledBy}
          aria-describedby={describedBy}
          data-closed={!visible || undefined}
          className="dialog-layer group fixed inset-0 grid place-items-center p-4"
          onPointerDown={(e) => {
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
          }}
        >
          {/* Click-outside to close. Not a button: the header's close button
              covers keyboards and screen readers, and a labelled full-screen
              button would get a hover tooltip and a Tab stop outside the panel. */}
          <div
            aria-hidden="true"
            onClick={onClose}
            className="absolute inset-0 transition-opacity duration-200 ease-out group-data-closed:opacity-0"
            style={{ background: "var(--scrim)" }}
          />
          <div
            ref={panelRef}
            tabIndex={-1}
            className={`dialog relative grid max-h-[80vh] w-full max-w-lg ${title ? "grid-rows-[auto_1fr_auto]" : "grid-rows-[1fr_auto]"} overflow-hidden outline-none transition-[opacity,transform] duration-200 ease-out group-data-closed:scale-95 group-data-closed:opacity-0 motion-reduce:transition-none motion-reduce:group-data-closed:scale-100`}
            style={maxWidth !== undefined ? { maxWidth } : undefined}
          >
            {title && (
              <div
                className="flex items-center justify-between px-4 py-3"
                style={{ borderBottom: "1px solid var(--border)" }}
              >
                <h2 id={titleId} style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{title}</h2>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={onClose}
                  className="iconbtn"
                >
                  <XMarkIcon className="size-3.5" aria-hidden="true" />
                </button>
              </div>
            )}
            {children}
            {footer}
          </div>
        </div>
      )}
    </>
  );
}
