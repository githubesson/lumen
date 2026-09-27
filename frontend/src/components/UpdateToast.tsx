import { useEffect, useState } from "react";
import { X as XMarkIcon } from "lucide-react";
import type { UpdateStatus } from "../electron";
import { useTransitionMount } from "../lib/useTransitionMount";
import BrandMark from "./BrandMark";
import { Button } from "./Button";

type Phase = "available" | "downloading" | "downloaded" | "failed";

/**
 * Follows the desktop updater. "checking" never replaces what's on screen, so
 * the periodic background re-check doesn't blink the toast away.
 */
function useUpdateStatus() {
  const electron = window.electron;
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    if (!electron?.getUpdateStatus) return;
    let active = true;
    const accept = (next: UpdateStatus) => {
      if (active && next.state !== "checking") setStatus(next);
    };
    void electron.getUpdateStatus().then(accept).catch(() => undefined);
    const unsubscribe = electron.onUpdateStatus?.(accept);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [electron]);

  return status;
}

/**
 * Bottom-right card in the main pane that offers an update the background
 * check found: download it, watch the progress, then restart to install.
 * Dismissing hides the current step for this session; a finished download
 * still comes back as "ready to install".
 */
export default function UpdateToast() {
  const electron = window.electron;
  const status = useUpdateStatus();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  // Set by our own download call, so errors are only shown for a download the
  // user started here, not for a failed background check.
  const [downloadStarted, setDownloadStarted] = useState(false);
  // The status the Download click was made against; any newer status (the
  // download starting, or failing) re-enables the button.
  const [requestedAt, setRequestedAt] = useState<UpdateStatus | null>(null);
  const [installing, setInstalling] = useState(false);

  const state = status?.state;
  const phase: Phase | null =
    state === "available" || state === "downloading" || state === "downloaded"
      ? state
      : state === "error" && downloadStarted
        ? "failed"
        : null;
  const version = status?.targetVersion ?? "";
  // "downloaded" is its own step; dismissing the offer doesn't hide it.
  const dismissKey = `${version}:${phase === "downloaded" ? "ready" : "offer"}`;
  const open = !!phase && !dismissed.has(dismissKey);

  // Keep the last content on screen while the card animates out.
  const [shown, setShown] = useState<{ phase: Phase; status: UpdateStatus } | null>(null);
  if (open && status && phase && (shown?.phase !== phase || shown.status !== status)) {
    setShown({ phase, status });
  }
  const { mounted, visible } = useTransitionMount(open, 200);

  // A found, finished or absent update closes out the download we started.
  const [prevState, setPrevState] = useState(state);
  if (state !== prevState) {
    setPrevState(state);
    if (state === "available" || state === "downloaded" || state === "up-to-date") {
      setDownloadStarted(false);
    }
  }

  if (!mounted || !shown) return null;

  const dismiss = () => setDismissed((prev) => new Set(prev).add(dismissKey));

  const download = async () => {
    if (!electron?.downloadUpdate) return;
    setRequestedAt(status);
    setDownloadStarted(true);
    try {
      await electron.downloadUpdate();
    } catch {
      setRequestedAt(null);
    }
  };

  // A failed download leaves the updater in "error"; a fresh check finds the
  // update again and puts the Download button back.
  const retry = () => void electron?.checkForUpdates?.().catch(() => undefined);

  const install = async () => {
    if (!electron?.installUpdate) return;
    setInstalling(true);
    try {
      await electron.installUpdate();
    } catch {
      setInstalling(false);
    }
  };

  const target = shown.status.targetVersion;
  const name = target ? `Lumen ${target}` : "A new version";
  const progress = Math.round(shown.status.progress ?? 0);
  const copy: Record<Phase, { title: string; detail: string }> = {
    available: {
      title: "Update available",
      detail: `${name} is out. You have ${shown.status.currentVersion}.`,
    },
    downloading: { title: "Downloading update", detail: name },
    downloaded: { title: "Ready to install", detail: "Restart Lumen to finish updating." },
    failed: { title: "Download failed", detail: shown.status.message },
  };
  const { title, detail } = copy[shown.phase];

  return (
    <section
      className="update-toast"
      data-visible={visible || undefined}
      role="status"
      aria-live="polite"
      aria-label="App update"
    >
      <div className="update-toast-head">
        <BrandMark />
        <div className="update-toast-text" key={shown.phase}>
          <div className="update-toast-title">{title}</div>
          <div className="update-toast-detail" data-error={shown.phase === "failed" || undefined}>
            {detail}
          </div>
        </div>
        <button
          type="button"
          className="iconbtn update-toast-close"
          aria-label="Dismiss update"
          onClick={dismiss}
        >
          <XMarkIcon className="size-3.5" />
        </button>
      </div>

      <div className="update-toast-foot" key={shown.phase}>
        {shown.phase === "available" && (
          <>
            <Button size="sm" variant="ghost" onClick={dismiss}>
              Later
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={requestedAt === status || !electron?.downloadUpdate}
              onClick={() => void download()}
            >
              Download
            </Button>
          </>
        )}
        {shown.phase === "downloading" && (
          <>
            <div
              className="update-toast-progress"
              role="progressbar"
              aria-label="Download progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              <div style={{ transform: `scaleX(${progress / 100})` }} />
            </div>
            <span className="update-toast-percent mono">{progress}%</span>
          </>
        )}
        {shown.phase === "downloaded" && (
          <>
            <Button size="sm" variant="ghost" disabled={installing} onClick={dismiss}>
              Later
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={installing}
              onClick={() => void install()}
            >
              {installing ? "Restarting…" : "Restart & install"}
            </Button>
          </>
        )}
        {shown.phase === "failed" && (
          <Button size="sm" onClick={retry}>
            Try again
          </Button>
        )}
      </div>
    </section>
  );
}
