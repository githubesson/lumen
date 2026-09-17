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
        borderRadius: "var(--radius-lg)",
        border: `1px solid ${checked ? "var(--primary)" : "var(--border)"}`,
        background: checked
          ? "color-mix(in oklch, var(--primary) 5%, transparent)"
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
        style={{ accentColor: "var(--primary)", marginTop: 2 }}
      />
      <span style={{ flex: 1 }}>
        <span
          style={{ display: "block", fontSize: 14, fontWeight: 500, color: "var(--foreground)" }}
        >
          {label}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 12,
            color: "var(--muted-foreground)",
            marginTop: 2,
          }}
        >
          {description}
        </span>
      </span>
    </label>
  );
}
