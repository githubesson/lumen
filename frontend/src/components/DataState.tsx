import type { ReactNode } from "react";
import ErrorBanner from "./ErrorBanner";
import LoadingState from "./LoadingState";

interface DataStateProps<T> {
  data: T | null;
  error?: string | null;
  loadingLabel?: string;
  empty?: ReactNode | ((data: T) => boolean);
  emptyState?: ReactNode;
  children: ReactNode | ((data: T) => ReactNode);
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Collapses the repeated async-data ternaries across list pages.
 * Renders LoadingState while data is null, ErrorBanner on error,
 * an optional empty state, and the children (or render prop) once data exists.
 */
export default function DataState<T>({
  data,
  error,
  loadingLabel,
  empty,
  emptyState,
  children,
  className,
  style,
}: DataStateProps<T>) {
  return (
    <div className={className} style={style}>
      {error && <ErrorBanner message={error} />}
      {data === null && !error && <LoadingState label={loadingLabel} />}
      {data !== null && (
        <>
          {(empty === undefined ||
            (typeof empty === "function" ? empty(data) : false)) &&
            emptyState}
          {(empty === undefined ||
            (typeof empty === "function" ? !empty(data) : !empty)) &&
            (typeof children === "function" ? children(data) : children)}
        </>
      )}
    </div>
  );
}
