import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/** Revalidate shared lists on return to Home without duplicating the initial load. */
export function useRefreshOnHome(refresh: () => void) {
  const { pathname } = useLocation();
  const previous = useRef(pathname);
  useEffect(() => {
    const returning = previous.current !== pathname && pathname === "/";
    previous.current = pathname;
    if (returning) refresh();
  }, [pathname, refresh]);
}
