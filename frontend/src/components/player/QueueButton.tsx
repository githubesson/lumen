import { useState, type ComponentProps } from "react";
import { ListMusic as QueueListIcon } from "lucide-react";
import QueuePopover from "../QueuePopover";

export default function QueueButton({
  miniPlayerMode,
  externalQueue,
}: {
  miniPlayerMode: boolean;
  externalQueue?: ComponentProps<typeof QueuePopover>["externalQueue"];
}) {
  // The popover anchor is held in state, not a ref: the popover reads the
  // element during render, and a ref's `.current` is not readable during
  // render under concurrent React (nor would it re-render the popover when it
  // lands).
  const [queueBtn, setQueueBtn] = useState<HTMLButtonElement | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);

  return (
    <>
      <button
        ref={setQueueBtn}
        type="button"
        className={"t-btn" + (queueOpen ? " active" : "")}
        title="Queue"
        aria-label="Queue"
        aria-expanded={queueOpen}
        onClick={() => setQueueOpen((v) => !v)}
      >
        <QueueListIcon className="size-3.5" />
      </button>
      <QueuePopover
        open={queueOpen}
        anchor={queueBtn}
        miniPlayerMode={miniPlayerMode}
        externalQueue={externalQueue}
        onClose={() => setQueueOpen(false)}
      />
    </>
  );
}
