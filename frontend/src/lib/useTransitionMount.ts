import { useEffect, useRef, useState } from "react";

export function useTransitionMount(open: boolean, durationMs = 200) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        if (raf2) cancelAnimationFrame(raf2);
      };
    }
    setVisible(false);
    const t = window.setTimeout(() => setMounted(false), durationMs);
    return () => window.clearTimeout(t);
  }, [open, durationMs]);

  return { mounted, visible };
}

export function usePopKey(trigger: boolean) {
  const [key, setKey] = useState(0);
  const prev = useRef(trigger);
  useEffect(() => {
    if (!prev.current && trigger) setKey((k) => k + 1);
    prev.current = trigger;
  }, [trigger]);
  return key;
}
