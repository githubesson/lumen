import type { CSSProperties, ReactNode } from "react";
import { Button } from "./Button";

/**
 * Right-aligned dialog action row. The default bordered variant is the sticky
 * footer chrome (for DialogShell's `footer` slot or equivalent scaffolds);
 * pass `bordered={false}` for an action row that sits inside a padded form
 * body. `start` puts leading content (selection counts, inline errors) on the
 * left. Replaces the divergent copies in Share/Upload/Edit/playlist dialogs.
 */
export default function DialogFooter({
  start,
  bordered = true,
  className,
  style,
  children,
}: {
  start?: ReactNode;
  bordered?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      className={className}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: start != null ? "space-between" : "flex-end",
        gap: 8,
        ...(bordered
          ? { padding: "10px 16px", borderTop: "1px solid var(--border-soft)" }
          : null),
        ...style,
      }}
    >
      {start}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {children}
      </div>
    </div>
  );
}

/**
 * The standard Cancel + submit pair for dialog forms. The submit button is
 * `type="submit"` so it drives the surrounding `<form>`.
 */
export function SaveCancelFooter({
  onCancel,
  busy,
  disabled,
  saveLabel = "Save",
  busyLabel = "Saving…",
  style,
}: {
  onCancel: () => void;
  busy: boolean;
  disabled?: boolean;
  saveLabel?: string;
  busyLabel?: string;
  style?: CSSProperties;
}) {
  return (
    <DialogFooter bordered={false} style={style}>
      <Button variant="ghost" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
      <Button type="submit" variant="primary" disabled={busy || disabled}>
        {busy ? busyLabel : saveLabel}
      </Button>
    </DialogFooter>
  );
}
