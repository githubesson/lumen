import { useEffect, useRef } from "react";
import { useTheme } from "../../context/Theme";

/**
 * Toggles between the compact rail and whichever expanded layout ("sidebar"
 * or "wide") was last in use.
 */
export function useSidebarToggle() {
  const { layout, setLayout } = useTheme();
  const lastExpandedRef = useRef<"sidebar" | "wide">(
    layout === "wide" ? "wide" : "sidebar",
  );
  useEffect(() => {
    if (layout === "sidebar" || layout === "wide") {
      lastExpandedRef.current = layout;
    }
  }, [layout]);
  return () =>
    setLayout(layout === "compact" ? lastExpandedRef.current : "compact");
}
