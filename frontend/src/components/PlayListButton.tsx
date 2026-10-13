import type { ReactNode } from "react";
import { Play as PlayIcon } from "lucide-react";
import { startListPlayback } from "@music-library/core/player/play-list";
import type { TrackListItem } from "../api";
import { usePlayer } from "../context/Player";
import { Button } from "./Button";

/**
 * A page's button that plays a whole list: from the top, or from a random
 * track with shuffle on, like the album and artist Play buttons. A component
 * of its own so the page doesn't re-render with the player.
 */
export default function PlayListButton({
  tracks,
  disabled,
  children,
}: {
  tracks: readonly TrackListItem[];
  disabled?: boolean;
  children: ReactNode;
}) {
  // Displayed state: `shuffle` is the controlled device's while casting.
  const { play, shuffle } = usePlayer();
  return (
    <Button
      variant="primary"
      disabled={disabled}
      onClick={() => startListPlayback(play, tracks, shuffle)}
      leadingIcon={<PlayIcon className="size-4" />}
    >
      {children}
    </Button>
  );
}
