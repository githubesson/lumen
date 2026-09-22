import { useState } from "react";
import {
  RefreshCw as ArrowPathIcon,
  FolderOpen as FolderOpenIcon,
  Wrench as WrenchScrewdriverIcon,
} from "lucide-react";
import { Button } from "../../components/Button";
import {
  chooseFH6GameDir,
  chooseFH6MediaSource,
  getFH6Status,
  installFH6Radio,
} from "../../lib/platform";
import type { FH6StatusPayload } from "../../electron";

/**
 * The Install panel of Lumen Radio: game-folder detection, station media
 * selection, and the mod install itself. `run` is the page's busy/error
 * wrapper, shared with the other panels.
 */
export default function FH6InstallPanel({
  status,
  setStatus,
  busy,
  run,
}: {
  status: FH6StatusPayload | null;
  setStatus: React.Dispatch<React.SetStateAction<FH6StatusPayload | null>>;
  busy: string | null;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
}) {
  const [mediaSource, setMediaSource] = useState("");
  const [installNote, setInstallNote] = useState<string | null>(null);

  async function refreshStatus() {
    const next = await getFH6Status?.();
    if (next) setStatus(next);
  }

  async function chooseGameDir() {
    await run("game-dir", async () => {
      const res = await chooseFH6GameDir?.();
      if (res?.status) setStatus(res.status);
    });
  }

  async function chooseMedia() {
    await run("media", async () => {
      const res = await chooseFH6MediaSource?.();
      if (res?.path) setMediaSource(res.path);
    });
  }

  async function install() {
    await run("install", async () => {
      const res = await installFH6Radio?.({
        gameDir: status?.gameDir,
        mediaSource,
        skipMedia: !mediaSource && status?.mediaInstalled === true,
      });
      if (!res?.ok) throw new Error(res?.error ?? "Install failed");
      if (res.status) setStatus(res.status);
      setInstallNote(
        `${res.copiedFiles ?? 0} files installed, ${res.brandedFiles ?? 0} branded`,
      );
    });
  }

  return (
    <section className="fh6-grid fh6-grid-single">
      <div className="fh6-panel">
        <div className="fh6-panel-head">
          <div>
            <h2>Install</h2>
            <p>{status?.gameDir || "No game folder selected"}</p>
          </div>
          <Button
            size="sm"
            leadingIcon={<ArrowPathIcon className="size-4" />}
            onClick={() => void refreshStatus()}
          >
            Scan
          </Button>
        </div>

        {status?.candidates && status.candidates.length > 0 && (
          <div className="fh6-candidates">
            {status.candidates.slice(0, 3).map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => setStatus((s) => (s ? { ...s, gameDir: candidate } : s))}
              >
                {candidate}
              </button>
            ))}
          </div>
        )}

        <div className="fh6-field-row">
          <Button
            leadingIcon={<FolderOpenIcon className="size-4" />}
            onClick={() => void chooseGameDir()}
            disabled={busy != null}
          >
            Game folder
          </Button>
          <Button
            leadingIcon={<FolderOpenIcon className="size-4" />}
            onClick={() => void chooseMedia()}
            disabled={busy != null}
          >
            Media ZIP/folder
          </Button>
        </div>

        <div className="fh6-path">{mediaSource || "No station media selected"}</div>

        <Button
          variant="primary"
          leadingIcon={<WrenchScrewdriverIcon className="size-4" />}
          onClick={() => void install()}
          disabled={
            busy != null ||
            !status?.gameDir ||
            (!mediaSource && status?.mediaInstalled !== true)
          }
        >
          Install Lumen Radio
        </Button>
        {installNote && <p className="fh6-note">{installNote}</p>}
      </div>
    </section>
  );
}
