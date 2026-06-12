import { useEffect, type ReactNode } from "react";
import { XMarkIcon } from "@heroicons/react/16/solid";
import { useTransitionMount } from "../lib/useTransitionMount";

/**
 * Shared modal scaffold: scrim + mount/exit transition + header with close
 * button + Escape-to-close. Promoted out of EditDialog so UploadDialog and the
 * playlist dialogs (which hand-rolled their own scaffold and dropped
 * Escape-to-close) can reuse it. Pass the scrollable body as `children` and an
 * optional sticky `footer`.
 */
export function DialogShell({
  open,
  title,
  onClose,
  children,
  footer,
  maxWidth,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Override the default max width (defaults to max-w-lg). */
  maxWidth?: number | string;
}) {
  const { mounted, visible } = useTransitionMount(open, 200);
  useEffect(() => {
    if (!mounted) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      onClose();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [mounted, onClose]);

  if (!mounted) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
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
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 transition-opacity duration-200 ease-out group-data-closed:opacity-0"
        style={{ background: "var(--scrim)" }}
      />
      <div
        className="dialog relative grid max-h-[80vh] w-full max-w-lg grid-rows-[auto_1fr_auto] overflow-hidden transition-[opacity,transform] duration-200 ease-out group-data-closed:scale-95 group-data-closed:opacity-0"
        style={maxWidth !== undefined ? { maxWidth } : undefined}
      >
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: "1px solid var(--border-soft)" }}
        >
          <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{title}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="iconbtn"
          >
            <XMarkIcon className="size-3.5" aria-hidden="true" />
          </button>
        </div>
        {children}
        {footer}
      </div>
    </div>
  );
}
