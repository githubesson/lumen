import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";

interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactElement<{ id?: string }>;
}

export function Field({ label, hint, error, children }: FieldProps) {
  const autoId = useId();
  const childId = isValidElement(children) ? children.props.id : undefined;
  const id = childId ?? autoId;
  const control = isValidElement(children)
    ? cloneElement(children, { id })
    : children;

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <label htmlFor={id} className="eyebrow">
        {label}
      </label>
      {control}
      {hint && !error && (
        <p style={{ fontSize: 11, color: "var(--fg-subtle)", margin: 0 }}>{hint}</p>
      )}
      {error && (
        <p
          role="alert"
          style={{ fontSize: 11, color: "var(--danger-fg)", margin: 0 }}
        >
          {error}
        </p>
      )}
    </div>
  );
}

export const TextInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function TextInput({ className, ...rest }, ref) {
  return (
    <input ref={ref} {...rest} className={`input ${className ?? ""}`.trim()} />
  );
});

/**
 * Plain `<select>` with the shared `.input` chrome. For the richer custom
 * dropdown (typeahead, minimal variant) use `Select` instead; this is the
 * lightweight native control for short option lists in forms.
 */
export const NativeSelect = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(function NativeSelect({ className, ...rest }, ref) {
  return (
    <select ref={ref} {...rest} className={`input ${className ?? ""}`.trim()} />
  );
});

/**
 * Side-by-side fields inside a dialog form — the repeated
 * `display:grid; gap:12; gridTemplateColumns:…` rows in the edit dialogs.
 */
export function FieldRow({
  columns = 2,
  style,
  children,
}: {
  columns?: number;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gap: 12,
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
