import { useEffect, useRef, useState } from "react";
import {
  ArrowPathIcon,
  CheckCircleIcon,
  FolderOpenIcon,
  PowerIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/16/solid";
import { Button } from "../components/Button";
import ErrorBanner from "../components/ErrorBanner";
import { TextInput } from "../components/Field";
import { Select } from "../components/Select";
import { api, type Playlist } from "../api";
import {
  chooseFH6GameDir,
  chooseFH6MediaSource,
  electron,
  getDesktopConfig,
  getFH6Status,
  installFH6Radio,
  isElectron,
  syncFH6Session,
} from "../lib/platform";
import {
  FH6_DEFAULT_BRIDGE_URL,
  bridgeGet,
  bridgePost,
  bridgePut,
  publishFH6Snapshot,
  type FH6BridgeState,
  type FH6QueueTrack,
} from "../lib/fh6";
import type { FH6StatusPayload } from "../electron";

type QueueMode = "tracks" | "favorites" | "recent" | "playlist";

interface BridgeConfig {
  lumen?: {
    queue_mode?: QueueMode;
    playlist_id?: string;
    search?: string;
    shuffle?: boolean;
    limit?: number;
  };
  audio?: {
    output_gain?: number;
  };
}

interface BridgeQueue {
  tracks: FH6QueueTrack[];
  current_index?: number;
}

interface SourceDraft {
  queue_mode: QueueMode;
  playlist_id: string;
  search: string;
  limit: number;
}

const DEFAULT_SOURCE_DRAFT: SourceDraft = {
  queue_mode: "tracks",
  playlist_id: "",
  search: "",
  limit: 500,
};

const MODE_OPTIONS = [
  { value: "tracks", label: "Tracks" },
  { value: "favorites", label: "Favorites" },
  { value: "recent", label: "Recent" },
  { value: "playlist", label: "Playlist" },
] satisfies Array<{ value: QueueMode; label: string }>;

export default function FH6Radio() {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<FH6StatusPayload | null>(null);
  const [mediaSource, setMediaSource] = useState("");
  const [state, setState] = useState<FH6BridgeState | null>(null);
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const [sourceDraft, setSourceDraft] = useState<SourceDraft>(DEFAULT_SOURCE_DRAFT);
  const [sourceDirty, setSourceDirty] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistsLoading, setPlaylistsLoading] = useState(false);
  const [queue, setQueue] = useState<FH6QueueTrack[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installNote, setInstallNote] = useState<string | null>(null);
  const sourceDirtyRef = useRef(false);

  const bridgeUrl = status?.bridgeUrl ?? FH6_DEFAULT_BRIDGE_URL;
  const lumen = state?.sources?.available?.find((s) => s.name === "lumen");
  const installed =
    !!status?.exeFound &&
    !!status.bridgeInstalled &&
    !!status.configInstalled &&
    !!status.mediaInstalled;
  const connected = !!state;
  const mode = sourceDraft.queue_mode;
  useEffect(() => {
    return () => publishFH6Snapshot(null);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!isElectron) return;
      const [cfg, nextStatus] = await Promise.all([
        getDesktopConfig?.(),
        getFH6Status?.(),
      ]);
      if (!alive) return;
      setEnabled(cfg?.fh6RadioEnabled === true);
      if (nextStatus) setStatus(nextStatus);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refreshBridge();
    void refreshPlaylists();
    const timer = window.setInterval(() => void refreshBridge(false), 2500);
    return () => window.clearInterval(timer);
  }, [enabled, bridgeUrl]);

  async function refreshPlaylists() {
    setPlaylistsLoading(true);
    try {
      setPlaylists(await api.listPlaylists());
    } catch {
      setPlaylists([]);
    } finally {
      setPlaylistsLoading(false);
    }
  }

  async function refreshStatus() {
    const next = await getFH6Status?.();
    if (next) setStatus(next);
  }

  async function refreshBridge(showError = true) {
    try {
      const [nextState, nextConfig, nextQueue] = await Promise.all([
        bridgeGet<FH6BridgeState>(bridgeUrl, "/api/state"),
        bridgeGet<BridgeConfig>(bridgeUrl, "/api/config"),
        bridgeGet<BridgeQueue>(bridgeUrl, "/api/source/lumen/queue"),
      ]);
      setState(nextState);
      publishFH6Snapshot({
        bridgeUrl,
        state: nextState,
        queue: nextQueue.tracks ?? [],
        currentIndex: nextQueue.current_index ?? 0,
      });
      setConfig(nextConfig);
      if (!sourceDirtyRef.current) setSourceDraft(configToSourceDraft(nextConfig));
      setQueue(nextQueue.tracks ?? []);
      if (showError) setError(null);
    } catch (e) {
      setState(null);
      publishFH6Snapshot({ bridgeUrl, state: null });
      if (showError) setError((e as Error).message);
    }
  }

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
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

  async function syncSession() {
    await run("sync", async () => {
      const res = await syncFH6Session?.();
      if (!res?.ok) throw new Error(res?.error ?? "Session sync failed");
      await refreshBridge();
    });
  }

  async function updateConfig(patch: BridgeConfig) {
    await run("config", async () => {
      await bridgePut(bridgeUrl, "/api/config", patch);
      await bridgePost(bridgeUrl, "/api/source/lumen/refresh");
      await refreshBridge(false);
    });
  }

  function updateSourceDraft(patch: Partial<SourceDraft>): SourceDraft {
    const next = { ...sourceDraft, ...patch };
    sourceDirtyRef.current = true;
    setSourceDirty(true);
    setSourceDraft(next);
    return next;
  }

  async function applySourceDraft(next = sourceDraft) {
    await run("config", async () => {
      if (!connected) throw new Error("Launch FH6 and sync the bridge before applying source changes.");
      const lumenPatch = {
        ...(config?.lumen ?? {}),
        queue_mode: next.queue_mode,
        playlist_id: next.playlist_id,
        search: next.search,
        limit: Math.max(1, Math.min(1000, Math.floor(next.limit || 500))),
      };
      await bridgePut(bridgeUrl, "/api/config", { lumen: lumenPatch });
      await bridgePost(bridgeUrl, "/api/source/lumen/refresh");
      sourceDirtyRef.current = false;
      setSourceDirty(false);
      await refreshBridge(false);
    });
  }

  if (!isElectron) {
    return (
      <div className="view fh6-radio-view">
        <PageTitle />
        <ErrorBanner message="Lumen Radio is only available in the desktop app." />
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="view fh6-radio-view">
        <PageTitle />
        <section className="fh6-panel">
          <div>
            <h2>Disabled</h2>
            <p>Enable Lumen Radio in desktop settings.</p>
          </div>
          <Button
            variant="primary"
            leadingIcon={<PowerIcon className="size-4" />}
            onClick={() => void electron?.openSettings()}
          >
            Open settings
          </Button>
        </section>
      </div>
    );
  }

  return (
    <div className="view fh6-radio-view">
      <PageTitle />

      {error && <ErrorBanner message={error} />}

      <section className="fh6-status-strip">
        <StatusPill ok={!!status?.packagedModAvailable} label="Bridge build" />
        <StatusPill ok={!!status?.exeFound} label="Game folder" />
        <StatusPill ok={!!status?.bridgeInstalled && !!status?.configInstalled} label="Mod files" />
        <StatusPill ok={!!status?.mediaInstalled} label="Station media" />
        <StatusPill ok={connected} label="FH6 running" />
        <Button
          size="sm"
          variant={connected ? "secondary" : "primary"}
          leadingIcon={<CheckCircleIcon className="size-4" />}
          onClick={() => void syncSession()}
          disabled={busy != null || !installed}
        >
          Sync
        </Button>
      </section>

      <section className="fh6-grid fh6-grid-single">
        <div className="fh6-panel fh6-install">
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

      <section className="fh6-panel">
        <div className="fh6-panel-head">
          <div>
            <h2>Source</h2>
            <p>
              {queue.length} tracks
              {lumen?.details?.last_error ? ` - ${lumen.details.last_error}` : ""}
            </p>
          </div>
          <Button
            size="sm"
            leadingIcon={<ArrowPathIcon className="size-4" />}
            onClick={() => void updateConfig({})}
            disabled={!connected || busy != null}
          >
            Refresh
          </Button>
        </div>
        {!connected && (
          <p className="fh6-note">
            You can edit these now. Launch FH6 and sync before applying them.
          </p>
        )}

        <div className="fh6-source-grid">
          <label>
            Mode
            <Select<QueueMode>
              value={mode}
              options={MODE_OPTIONS}
              onChange={(value) => {
                const next = updateSourceDraft({ queue_mode: value });
                if (connected) void applySourceDraft(next);
              }}
              disabled={busy != null}
            />
          </label>
          <label>
            Search
            <TextInput
              value={sourceDraft.search}
              placeholder="Optional"
              onChange={(e) => updateSourceDraft({ search: e.currentTarget.value })}
              onBlur={() => {
                if (connected && sourceDirtyRef.current) void applySourceDraft();
              }}
              disabled={busy != null}
            />
          </label>
          <label>
            Playlist
            <Select<string>
              value={sourceDraft.playlist_id}
              placeholder={playlistsLoading ? "Loading..." : "Select playlist"}
              options={playlists.map((playlist) => ({
                value: playlist.id,
                label: playlist.name,
              }))}
              onChange={(playlistId) => {
                const next = updateSourceDraft({
                  queue_mode: "playlist",
                  playlist_id: playlistId,
                });
                if (connected) void applySourceDraft(next);
              }}
              disabled={busy != null}
            />
          </label>
          <label>
            Limit
            <TextInput
              type="number"
              min={1}
              max={1000}
              value={sourceDraft.limit}
              onChange={(e) =>
                updateSourceDraft({ limit: Number(e.currentTarget.value || 500) })
              }
              onBlur={() => {
                if (connected && sourceDirtyRef.current) void applySourceDraft();
              }}
              disabled={busy != null}
            />
          </label>
        </div>
        <div className="fh6-field-row">
          <Button
            variant="primary"
            onClick={() => void applySourceDraft()}
            disabled={!connected || busy != null || !sourceDirty}
          >
            Apply source
          </Button>
        </div>

        <div className="fh6-queue">
          {queue.slice(0, 24).map((track) => (
            <div key={track.id} className="fh6-queue-row">
              <span>{track.title || "Untitled"}</span>
              <small>{track.artist || track.album || "Lumen"}</small>
            </div>
          ))}
          {queue.length === 0 && <p className="fh6-note">No queue loaded.</p>}
        </div>
      </section>
    </div>
  );
}

function configToSourceDraft(config: BridgeConfig | null): SourceDraft {
  return {
    queue_mode: config?.lumen?.queue_mode ?? DEFAULT_SOURCE_DRAFT.queue_mode,
    playlist_id: config?.lumen?.playlist_id ?? DEFAULT_SOURCE_DRAFT.playlist_id,
    search: config?.lumen?.search ?? DEFAULT_SOURCE_DRAFT.search,
    limit: config?.lumen?.limit ?? DEFAULT_SOURCE_DRAFT.limit,
  };
}

function PageTitle() {
  return (
    <header className="page-header">
      <div>
        <h1 className="page-title">Lumen Radio</h1>
        <p className="section-sub">Forza Horizon 6</p>
      </div>
    </header>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return <span className={`fh6-status-pill${ok ? " ok" : ""}`}>{label}</span>;
}
