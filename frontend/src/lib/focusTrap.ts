// Shared by the modal dialogs (SettingsDialog, DialogShell).

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** Keep Tab / Shift+Tab cycling inside the dialog instead of the app behind it. */
export function trapTab(event: KeyboardEvent, panel: HTMLElement | null) {
  if (!panel) return;
  // Tab skips tabIndex -1 controls, so they can't be the ends of the cycle.
  const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.tabIndex >= 0 && el.getClientRects().length > 0,
  );
  if (items.length === 0) {
    event.preventDefault();
    panel.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const current = document.activeElement;
  const inside = current instanceof Node && panel.contains(current);
  if (event.shiftKey && (!inside || current === first || current === panel)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (!inside || current === last)) {
    event.preventDefault();
    first.focus();
  }
}
