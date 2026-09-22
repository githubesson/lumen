import { useEffect, useState } from "react";
import { useLyricsPanel } from "../../context/LyricsPanel";
import {
  canSetMiniPlayer,
  setMiniPlayerMode as setElectronMiniPlayer,
} from "../../lib/platform";

/**
 * Desktop mini player window mode. Mirrors the mode onto
 * `<html data-mini-player>` and closes the lyrics panel while it is on.
 */
export function useMiniPlayerMode() {
  const { open: lyricsOpen, setOpen: setLyricsOpen } = useLyricsPanel();
  const [miniPlayerMode, setMiniPlayerMode] = useState(false);

  useEffect(() => {
    document.documentElement.toggleAttribute(
      "data-mini-player",
      miniPlayerMode,
    );
    return () => {
      document.documentElement.removeAttribute("data-mini-player");
    };
  }, [miniPlayerMode]);

  useEffect(() => {
    if (miniPlayerMode && lyricsOpen) {
      setLyricsOpen(false);
    }
  }, [miniPlayerMode, lyricsOpen, setLyricsOpen]);

  const toggleMiniPlayerMode = async () => {
    if (!canSetMiniPlayer()) return;
    const next = !miniPlayerMode;
    setMiniPlayerMode(next);
    const result = await setElectronMiniPlayer(next);
    if (!result.ok || result.miniPlayer !== next) {
      setMiniPlayerMode(result.miniPlayer);
    }
  };

  return { miniPlayerMode, toggleMiniPlayerMode };
}
