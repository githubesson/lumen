import type { CSSProperties, ReactNode } from "react";
import clsx from "clsx";

interface FieldsetProps {
  legend: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/**
 * Borderless fieldset with the project's standard uppercase-mono legend.
 * Used for grouped radio/card options like visibility or upload scope.
 */
export default function Fieldset({
  legend,
  children,
  className,
  style,
}: FieldsetProps) {
  return (
    <fieldset
      className={clsx(className)}
      style={{
        border: 0,
        padding: 0,
        margin: 0,
        display: "grid",
        gap: 8,
        ...style,
      }}
    >
      <legend
        className="mono"
        style={{
          fontSize: 10,
          color: "var(--fg-subtle)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          padding: 0,
          marginBottom: 4,
        }}
      >
        {legend}
      </legend>
      {children}
    </fieldset>
  );
}
