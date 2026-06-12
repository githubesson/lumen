import type { ReactNode } from "react";

/**
 * The single red `role="alert"` error box. Replaces ~12 inline copies and the
 * 3-4 divergent local ErrorBanner/ErrorLine re-extractions. Styling lives in
 * the `.error-banner` class (driven by the --danger-* theme tokens), so it
 * themes correctly in light mode unlike the old hardcoded literals.
 */
export default function ErrorBanner({
  message,
  children,
  className,
}: {
  message?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div role="alert" className={`error-banner${className ? ` ${className}` : ""}`}>
      {children ?? message}
    </div>
  );
}
