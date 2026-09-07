import { useEffect, useState } from "react";
import { useAuth } from "../context/Auth";
import { electron } from "../lib/platform";
import CenteredCard from "./CenteredCard";
import { Button } from "./Button";

export default function StartupConnection() {
  const { status, refreshError, refresh } = useAuth();
  const [slow, setSlow] = useState(false);
  const connecting = status === "loading";
  const desktop = electron();

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <CenteredCard title={connecting ? "Connecting to your library" : "Your server is unavailable"}>
      <p role="status" aria-live="polite" className="text-sm text-[var(--fg-muted)]">
        {connecting
          ? slow ? "This is taking longer than usual. Check your connection or server settings." : "Checking your session…"
          : refreshError}
      </p>
      <div className="flex gap-3 mt-5">
        {!connecting && <Button variant="primary" onClick={() => { setSlow(false); void refresh(); }}>Try again</Button>}
        {desktop && <Button onClick={() => void desktop.openSettings()}>Server settings</Button>}
      </div>
    </CenteredCard>
  );
}
