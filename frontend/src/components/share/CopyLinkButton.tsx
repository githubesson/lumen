import { useEffect, useState } from "react";
import {
  Check as CheckIcon,
  ClipboardCopy as ClipboardDocumentIcon,
} from "lucide-react";
import { Button } from "../Button";
import IosSpinner from "../IosSpinner";

/** The copy button's three states, in one list so they can be stacked in a
 *  single grid cell and keep the button's width stable while they swap. */
const COPY_LABELS = ["Copy share link", "Generating share link…", "Link copied"] as const;
type CopyLabel = (typeof COPY_LABELS)[number];

/**
 * Label state for CopyLinkButton. Lives in the dialog rather than the button
 * so it outlasts DialogShell unmounting its children on close.
 */
export function useCopyLabel(busy: boolean, copied: boolean) {
  // The button's label lags the real state by the length of the blur, so the
  // text changes while it is masked instead of teleporting.
  const copyLabel: CopyLabel = busy
    ? "Generating share link…"
    : copied
      ? "Link copied"
      : "Copy share link";
  const [shownLabel, setShownLabel] = useState<CopyLabel>(copyLabel);
  const swapping = shownLabel !== copyLabel;
  useEffect(() => {
    if (!swapping) return;
    const t = window.setTimeout(() => setShownLabel(copyLabel), 180);
    return () => window.clearTimeout(t);
  }, [swapping, copyLabel]);
  return { shownLabel, swapping };
}

/** Primary "copy share link" action whose label morphs between states. */
export default function CopyLinkButton({
  shownLabel,
  swapping,
  disabled,
  onClick,
}: {
  shownLabel: CopyLabel;
  swapping: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="primary"
      className="btn-morph"
      data-swapping={swapping || undefined}
      onClick={onClick}
      disabled={disabled}
      leadingIcon={
        shownLabel === "Generating share link…" ? (
          <IosSpinner className="share-copy-spinner" label="Generating" />
        ) : shownLabel === "Link copied" ? (
          <CheckIcon className="size-3.5" />
        ) : (
          <ClipboardDocumentIcon className="size-3.5" />
        )
      }
    >
      <span>
        {COPY_LABELS.map((l) => (
          <span key={l} data-hidden={l !== shownLabel || undefined}>
            {l}
          </span>
        ))}
      </span>
    </Button>
  );
}
