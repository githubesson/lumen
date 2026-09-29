import { useId, useState, type ReactNode } from "react";
import { ChevronRight as ChevronRightIcon } from "lucide-react";
import { Button } from "../Button";

/**
 * A "› Label  N" toggle over content that starts hidden, for long admin lists
 * that don't need to be read every visit. The content stays mounted (only
 * hidden) so `aria-controls` always points at something. Pass `open` and
 * `onOpenChange` to control it from outside, e.g. to open it from a link.
 */
export default function Disclosure({
  id,
  label,
  count,
  open: controlledOpen,
  onOpenChange,
  children,
}: {
  id?: string;
  label: ReactNode;
  count?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const autoId = useId();
  const regionId = id ?? autoId;
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const toggle = () => {
    setOwnOpen(!open);
    onOpenChange?.(!open);
  };
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div>
        {/* Pulled left by the button's padding so the chevron lines up with
            the content edge. */}
        <Button
          variant="ghost"
          size="sm"
          style={{ marginLeft: -10 }}
          aria-expanded={open}
          aria-controls={regionId}
          onClick={toggle}
          leadingIcon={
            <ChevronRightIcon className="size-3.5 disclosure-chevron" aria-hidden="true" />
          }
        >
          {label}
          {count != null && (
            <span style={{ color: "var(--muted-foreground)" }}>{count}</span>
          )}
        </Button>
      </div>
      <div id={regionId} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
