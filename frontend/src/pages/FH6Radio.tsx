import { useCallback, useEffect, useState } from "react";
import {
  RefreshCw as ArrowPathIcon,
  CircleCheck as CheckCircleIcon,
  Power as PowerIcon,
} from "lucide-react";
import { Button } from "../components/Button";
import ErrorBanner from "../components/ErrorBanner";
import { TextInput } from "../components/Field";
import { Select } from "../components/Select";
import { api, type Playlist } from "../api";
import { getFH6Status, isElectron, syncFH6Session } from "../lib/platform";
import { useDesktopConfig } from "../lib/desktopConfig";
import { useOpenSettings } from "../components/shell/openSettings";
import {
  FH6_DEFAULT_BRIDGE_URL,
  bridgePost,
  bridgePut,
  publishFH6Snapshot,
} from "../lib/fh6";
import type { FH6StatusPayload } from "../electron";
import FH6InstallPanel from "./fh6/FH6InstallPanel";
import {
  useFH6Bridge,
  type BridgeConfig,
  type QueueMode,
} from "./fh6/useFH6Bridge";

const MODE_OPTIONS = [
  { value: "tracks", label: "Tracks" },
  { value: "favorites", label: "Favorites" },
  { value: "recent", label: "Recent" },
  { value: "playlist", label: "Playlist" },
] satisfies Array<{ value: QueueMode; label: string }>;

export default function FH6Radio() {
  const enabled = useDesktopConfig()?.fh6RadioEnabled === true;
  const openSettings = useOpenSettings();
  const [status, setStatus] = useState<FH6StatusPayload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bridgeUrl = status?.bridgeUrl ?? FH6_DEFAULT_BRIDGE_URL;
  const {
    state,
    config,
    queue,
    refreshBridge,
    sourceDraft,
    sourceDirty,
    updateSourceDraft,
    markSourceApplied,
    hasUnappliedSource,
  } = useFH6Bridge(bridgeUrl, setError);
  const { playlists, playlistsLoading, refreshPlaylists } = usePlaylistOptions();

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
      if (!isElectron()) return;
      const nextStatus = await getFH6Status?.();
      if (!alive) return;
      if (nextStatus) setStatus(nextStatus);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // refreshBridge is memoized on bridgeUrl, so a new bridge URL restarts this
  // polling lifecycle; refreshPlaylists is stable.
  useEffect(() => {
    if (!enabled) return;
    void refreshBridge();
    void refreshPlaylists();
    const timer = window.setInterval(() => void refreshBridge(false), 2500);
    return () => window.clearInterval(timer);
  }, [enabled, refreshBridge, refreshPlaylists]);

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
      markSourceApplied();
      await refreshBridge(false);
    });
  }

  if (!isElectron()) {
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
            onClick={() => openSettings("desktop")}
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

      <FH6InstallPanel
        status={status}
        setStatus={setStatus}
        busy={busy}
        run={run}
      />

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
                if (connected && hasUnappliedSource()) void applySourceDraft();
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
                if (connected && hasUnappliedSource()) void applySourceDraft();
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

/** Playlists offered as a Lumen Radio source. */
function usePlaylistOptions() {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistsLoading, setPlaylistsLoading] = useState(false);

  const refreshPlaylists = useCallback(async () => {
    setPlaylistsLoading(true);
    try {
      setPlaylists(await api.listPlaylists());
    } catch {
      setPlaylists([]);
    } finally {
      setPlaylistsLoading(false);
    }
  }, []);

  return { playlists, playlistsLoading, refreshPlaylists };
}
