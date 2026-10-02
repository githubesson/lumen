import { Smartphone as DevicePhoneMobileIcon } from "lucide-react";
import { useRemoteControlIndicator } from "@music-library/core";

export default function RemoteControlIndicator() {
  const event = useRemoteControlIndicator();

  if (!event) return null;

  // Keep this node unkeyed while visible: subsequent remote commands update
  // its metadata and extend the timer without replaying the entrance animation.
  return (
    <div
      className="remote-control-indicator"
      role="status"
      aria-live="polite"
      title={`Remote ${event.action.replaceAll("_", " ")}`}
    >
      <DevicePhoneMobileIcon aria-hidden="true" />
      <span>Controlled from another device</span>
    </div>
  );
}
