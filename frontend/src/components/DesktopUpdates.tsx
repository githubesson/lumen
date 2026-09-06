import { useEffect, useRef, useState } from "react";
import type { UpdateBranch, UpdateStatus } from "../electron";

export default function DesktopUpdates() {
  const electron = window.electron;
  const initialized = useRef(false);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [branch, setBranch] = useState<UpdateBranch>("main");
  const [repoUrl, setRepoUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!electron?.getUpdateStatus) return;
    let active = true;
    const accept = (next: UpdateStatus) => {
      if (!active) return;
      setStatus(next);
      if (!initialized.current) {
        initialized.current = true;
        setBranch(next.branch);
        setRepoUrl(next.repoUrl || next.defaultRepoUrl);
      }
    };
    void electron.getUpdateStatus().then(accept).catch(() => undefined);
    const unsubscribe = electron.onUpdateStatus?.(accept);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [electron]);

  if (!electron?.getUpdateStatus || !status) return null;

  const save = async () => {
    if (!electron.saveUpdateConfig) return;
    setBusy(true);
    setError(null);
    try {
      const result = await electron.saveUpdateConfig({
        branch,
        repoUrl: repoUrl.trim() || status.defaultRepoUrl,
      });
      if (!result.ok || !result.status) {
        throw new Error(result.error || "Could not save the update source.");
      }
      setStatus(result.status);
      setBranch(result.status.branch);
      setRepoUrl(result.status.repoUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save updates.");
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    if (!electron.checkForUpdates) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await electron.checkForUpdates());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Update check failed.");
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (!electron.installUpdate) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await electron.installUpdate());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Update install failed.");
      setBusy(false);
    }
  };

  const dirty = branch !== status.branch || repoUrl.trim() !== status.repoUrl;
  const checking = status.state === "checking" || status.state === "downloading";

  return (
    <div className="tweak-row">
      <div className="tweak-label">
        <span>Desktop updates</span>
        <span>{status.state}</span>
      </div>
      <div className="tweak-seg">
        <button
          type="button"
          className={branch === "main" ? "active" : ""}
          disabled={busy || checking}
          onClick={() => setBranch("main")}
        >
          main
        </button>
        <button
          type="button"
          className={branch === "dev" ? "active" : ""}
          disabled={busy || checking}
          onClick={() => setBranch("dev")}
        >
          dev
        </button>
      </div>
      <input
        className="tweak-input"
        value={repoUrl}
        disabled={busy || checking}
        onChange={(event) => setRepoUrl(event.currentTarget.value)}
        placeholder={status.defaultRepoUrl}
        aria-label="Update repository URL"
        spellCheck={false}
      />
      <div className="tweak-seg">
        <button
          type="button"
          disabled={busy || checking || !dirty}
          onClick={() => void save()}
        >
          save source
        </button>
        {status.canInstall ? (
          <button type="button" disabled={busy} onClick={() => void install()}>
            restart &amp; install
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || checking || !status.canCheck || dirty}
            onClick={() => void check()}
          >
            {checking ? "checking…" : "check now"}
          </button>
        )}
      </div>
      <div
        className="tweak-status mono"
        data-error={status.state === "error" || !!error || undefined}
      >
        {error || status.message}
      </div>
    </div>
  );
}
