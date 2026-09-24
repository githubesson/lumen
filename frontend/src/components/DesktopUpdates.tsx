import { useEffect, useRef, useState } from "react";
import type { UpdateBranch, UpdateStatus } from "../electron";
import { Button } from "./Button";
import { Select, type SelectOption } from "./Select";
import SettingRow from "./SettingRow";

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

  const failed = status.state === "error" || !!error;
  const channels: SelectOption<UpdateBranch>[] = [
    { value: "main", label: "Main" },
    { value: "dev", label: "Dev" },
  ];

  return (
    <>
      <SettingRow label="Update channel" description="Dev gets new builds sooner.">
        <Select
          variant="minimal"
          aria-label="Update channel"
          value={branch}
          options={channels}
          disabled={busy || checking}
          onChange={setBranch}
        />
      </SettingRow>
      <SettingRow
        label="Update source"
        description="GitHub repository that publishes Lumen releases."
        below={
          <input
            className="input mono settings-input"
            value={repoUrl}
            disabled={busy || checking}
            onChange={(event) => setRepoUrl(event.currentTarget.value)}
            placeholder={status.defaultRepoUrl}
            aria-label="Update repository URL"
            spellCheck={false}
          />
        }
      >
        <Button size="sm" disabled={busy || checking || !dirty} onClick={() => void save()}>
          Save
        </Button>
      </SettingRow>
      <SettingRow
        label="Status"
        description={
          <span className="mono" data-error={failed || undefined}>
            {error || status.message || status.state}
          </span>
        }
      >
        {status.canInstall ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void install()}>
            Restart &amp; install
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy || checking || !status.canCheck || dirty}
            onClick={() => void check()}
          >
            {checking ? "Checking…" : "Check now"}
          </Button>
        )}
      </SettingRow>
    </>
  );
}
