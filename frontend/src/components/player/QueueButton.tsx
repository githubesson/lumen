import { useCallback, useState } from "react";
import { ListMusic as QueueListIcon } from "lucide-react";
import QueuePopover, { type ExternalQueue } from "../QueuePopover";
import { usePopoverOpen, type MiniPanelToggle } from "./useMiniPlayerMode";

export default function QueueButton({
  externalQueue,
  panel,
}: {
  externalQueue?: ExternalQueue;
  /** In the mini player the queue opens in its panel instead of a popover. */
  panel?: MiniPanelToggle;
}) {
  // The popover anchor is held in state, not a ref: the popover reads the
  // element during render, and a ref's `.current` is not readable during
  // render under concurrent React (nor would it re-render the popover when it
  // lands).
  const [queueBtn, setQueueBtn] = useState<HTMLButtonElement | null>(null);
  const [queueOpen, setQueueOpen] = usePopoverOpen(!!panel);
  const open = panel ? panel.open : queueOpen;
  // Stable, so the memoized queue list doesn't re-render on every player tick.
  const closeQueue = useCallback(() => setQueueOpen(false), [setQueueOpen]);

  return (
    <>
      <button
        ref={setQueueBtn}
        type="button"
        className={"t-btn" + (open ? " active" : "")}
        title="Queue"
        aria-label="Queue"
        aria-expanded={open}
        aria-controls={panel?.controls}
        onClick={panel ? panel.onToggle : () => setQueueOpen((v) => !v)}
      >
        <QueueListIcon className="size-3.5" />
      </button>
      <QueuePopover
        open={queueOpen}
        anchor={queueBtn}
        externalQueue={externalQueue}
        onClose={closeQueue}
      />
    </>
  );
}
