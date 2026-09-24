import { useEffect, useRef, useState } from "react";
import type { UpdateBranch, UpdateStatus } from "../electron";
import { Button } from "./Button";
import { Select, type SelectOption } from "./Select";
import SettingRow from "./SettingRow";

/**
 * Update status plus the unsaved channel / source draft. Owned by the settings
 * dialog rather than the Updates rows, so the draft survives switching
 * sections or searching. Each stretch of `enabled` is one session: closing
 * ends it (dropping late results) and the next one restarts the draft from
 * the saved config. The last status is kept so the rows can fade out with
 * the dialog. Returns null outside the desktop app and until a status arrives.
 */
export function useDesktopUpdates(enabled: boolean) {
  const electron = window.electron;
  const initialized = useRef(false);
  // Bumped on close; save / check / install results from an earlier session
  // are dropped so a late failure can't reappear on the next open.
  const session = useRef(0);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [branch, setBranch] = useState<UpdateBranch>("main");
  const [repoUrl, setRepoUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !electron?.getUpdateStatus) return;
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
      // Reopening starts from the saved config, without a stale failure.
      initialized.current = false;
      session.current += 1;
      setBusy(false);
      setError(null);
      unsubscribe?.();
    };
  }, [enabled, electron]);

  if (!electron?.getUpdateStatus || !status) return null;

  const run = async (
    task: (live: () => boolean) => Promise<void>,
    failure: string,
    { holdBusy = false } = {},
  ) => {
    const id = session.current;
    const live = () => session.current === id;
    setBusy(true);
    setError(null);
    try {
      await task(live);
      if (live() && !holdBusy) setBusy(false);
    } catch (cause) {
      if (!live()) return;
      setError(cause instanceof Error ? cause.message : failure);
      setBusy(false);
    }
  };

  const save = () => {
    const saveConfig = electron.saveUpdateConfig;
    if (!saveConfig) return;
    return run(async (live) => {
      const result = await saveConfig({
        branch,
        repoUrl: repoUrl.trim() || status.defaultRepoUrl,
      });
      if (!result.ok || !result.status) {
        throw new Error(result.error || "Could not save the update source.");
      }
      if (!live()) return;
      setStatus(result.status);
      setBranch(result.status.branch);
      setRepoUrl(result.status.repoUrl);
    }, "Could not save updates.");
  };

  const check = () => {
    const checkForUpdates = electron.checkForUpdates;
    if (!checkForUpdates) return;
    return run(async (live) => {
      const next = await checkForUpdates();
      if (live()) setStatus(next);
    }, "Update check failed.");
  };

  // Busy stays on after a successful install call: the app is restarting.
  const install = () => {
    const installUpdate = electron.installUpdate;
    if (!installUpdate) return;
    return run(
      async (live) => {
        const next = await installUpdate();
        if (live()) setStatus(next);
      },
      "Update install failed.",
      { holdBusy: true },
    );
  };

  return { status, branch, setBranch, repoUrl, setRepoUrl, busy, error, save, check, install };
}

export type DesktopUpdatesState = NonNullable<ReturnType<typeof useDesktopUpdates>>;

export default function DesktopUpdates({ updates }: { updates: DesktopUpdatesState }) {
  const { status, branch, setBranch, repoUrl, setRepoUrl, busy, error, save, check, install } =
    updates;
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
