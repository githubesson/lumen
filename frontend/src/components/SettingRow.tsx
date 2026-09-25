import type { ReactNode } from "react";

/**
 * One settings line: label (and optional description) on the left, the
 * control on the right. `below` spans the full width under both, for inputs
 * too wide to sit beside the label.
 */
export default function SettingRow({
  id,
  label,
  description,
  error,
  below,
  children,
}: {
  /** Gives the label `${id}-label` and the description `${id}-desc`, for controls to reference. */
  id?: string;
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  below?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-main">
        <div className="settings-row-text">
          <div className="settings-row-label" id={id && `${id}-label`}>
            {label}
          </div>
          {description && (
            <div className="settings-row-desc" id={id && `${id}-desc`}>
              {description}
            </div>
          )}
        </div>
        {children && <div className="settings-row-control">{children}</div>}
      </div>
      {below}
      {error && <div className="settings-row-error">{error}</div>}
    </div>
  );
}
