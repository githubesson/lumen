import { useEffect, useId, useRef, useState } from "react";
import type { DesktopConfigPatch } from "../electron";
import { testDesktopServer, updateDesktopConfig, useDesktopConfig } from "../lib/desktopConfig";
import { Button } from "./Button";
import SettingRow from "./SettingRow";
import Switch from "./Switch";

type Key = keyof DesktopConfigPatch;

/**
 * The desktop app's server and window options, plus the unsaved server URL
 * draft. Owned by the settings dialog, like the updater state, so the draft
 * survives switching sections or searching. Closing the dialog ends the
 * session: the draft resets and late failures are dropped. Toggles save as
 * they flip. Returns null outside the desktop app and until the config loads.
 */
export function useDesktopSettings(enabled: boolean) {
  const config = useDesktopConfig();
  // Bumped on close so a save that fails after it can't reappear on reopen.
  const session = useRef(0);
  const [serverDraft, setServerDraft] = useState<string | null>(null);
  const [pending, setPending] = useState<Partial<Record<Key, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});

  useEffect(() => {
    if (!enabled) return;
    return () => {
      session.current += 1;
      setServerDraft(null);
      setPending({});
      setErrors({});
    };
  }, [enabled]);

  if (!config) return null;

  const save = async (key: Key, patch: DesktopConfigPatch) => {
    const id = session.current;
    const live = () => session.current === id;
    setPending((p) => ({ ...p, [key]: true }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    let result: Awaited<ReturnType<typeof updateDesktopConfig>>;
    try {
      // Only switch to a server that answers, at the origin it answers on.
      const tested = patch.backendUrl === undefined ? null : await testDesktopServer(patch.backendUrl);
      if (tested && !tested.ok) throw new Error(tested.error);
      result = await updateDesktopConfig(tested ? { backendUrl: tested.url } : patch);
    } catch (cause) {
      result = { ok: false, error: cause instanceof Error ? cause.message : "Could not save." };
    }
    if (!live()) return;
    // A new server reloads the app; stay busy until it does.
    if (result.ok && result.changed) return;
    setPending((p) => ({ ...p, [key]: false }));
    if (!result.ok) {
      const { error } = result;
      setErrors((e) => ({ ...e, [key]: error }));
      return;
    }
    if (key === "backendUrl") setServerDraft(null);
  };

  const server = serverDraft ?? config.backendUrl;
  return {
    config,
    server,
    setServer: setServerDraft,
    serverDirty: server.trim() !== config.backendUrl,
    saveServer: () => save("backendUrl", { backendUrl: server }),
    toggle: (key: Exclude<Key, "backendUrl">, value: boolean) => save(key, { [key]: value }),
    pending,
    errors,
  };
}

export type DesktopSettingsState = NonNullable<ReturnType<typeof useDesktopSettings>>;

export function ServerSetting({ desktop }: { desktop: DesktopSettingsState }) {
  const { server, setServer, serverDirty, saveServer, pending, errors } = desktop;
  const busy = !!pending.backendUrl;
  return (
    <SettingRow
      label="Server"
      description="The Lumen server this app uses. Switching servers signs you out."
      error={errors.backendUrl}
      below={
        <input
          className="input mono settings-input"
          aria-label="Server URL"
          placeholder="https://music.example.com"
          spellCheck={false}
          value={server}
          readOnly={busy}
          onChange={(e) => setServer(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && serverDirty) void saveServer();
          }}
        />
      }
    >
      <Button size="sm" disabled={busy || !serverDirty} onClick={() => void saveServer()}>
        {busy ? "Connecting…" : "Save"}
      </Button>
    </SettingRow>
  );
}

export function ToggleSetting({
  desktop,
  setting,
  label,
  description,
}: {
  desktop: DesktopSettingsState;
  setting: "discordEnabled" | "alwaysOnTop" | "fh6RadioEnabled";
  label: string;
  description: string;
}) {
  const id = useId();
  return (
    <SettingRow id={id} label={label} description={description} error={desktop.errors[setting]}>
      <Switch
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-desc`}
        checked={desktop.config[setting]}
        disabled={!!desktop.pending[setting]}
        onChange={(value) => void desktop.toggle(setting, value)}
      />
    </SettingRow>
  );
}
