import type { ReactNode } from "react";

/**
 * Accent-bordered radio card (label + supporting description). Unifies the
 * near-identical VisibilityOption (PlaylistNew) and ScopeOption (UploadDialog)
 * copies; the checked state gets the `surface` elevation both should share.
 */
export default function RadioCardOption({
  name,
  value,
  checked,
  onChange,
  label,
  description,
  className,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  label: ReactNode;
  description: ReactNode;
  className?: string;
}) {
  return (
    <label
      className={`${checked ? "surface" : ""} ${className ?? ""}`.trim() || undefined}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: 12,
        borderRadius: "var(--r-md)",
        border: `1px solid ${checked ? "color-mix(in oklch, var(--accent) 40%, var(--border))" : "var(--border)"}`,
        background: checked
          ? "color-mix(in oklch, var(--accent) 10%, var(--bg-elev-2))"
          : "transparent",
        cursor: "pointer",
      }}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        style={{ accentColor: "var(--accent)", marginTop: 2 }}
      />
      <span style={{ flex: 1 }}>
        <span
          style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--fg)" }}
        >
          {label}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 12,
            color: "var(--fg-muted)",
            marginTop: 2,
          }}
        >
          {description}
        </span>
      </span>
    </label>
  );
}
