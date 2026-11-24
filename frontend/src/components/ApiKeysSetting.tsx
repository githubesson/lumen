import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import {
  Check as CheckIcon,
  Clipboard as ClipboardIcon,
  KeyRound as KeyIcon,
  Trash2 as TrashIcon,
} from "lucide-react";
import { api, ApiError, errorMessage, type ApiKey, type CreatedApiKey } from "../api";
import { useAuth } from "../context/Auth";
import { useConfirm } from "../context/Confirm";
import { copyText } from "../lib/clipboard";
import { useDesktopConfig } from "../lib/desktopConfig";
import { fmtDate } from "../lib/format";
import { isElectron } from "../lib/platform";
import { useApiResource } from "../lib/useApiResource";
import { useCopiedFlag } from "../lib/useCopiedFlag";
import { Button } from "./Button";
import { Select, type SelectOption } from "./Select";
import SettingRow from "./SettingRow";

const EXPIRY: SelectOption[] = [
  { value: "0", label: "Never expires" },
  { value: "30", label: "Expires in 30 days" },
  { value: "90", label: "Expires in 90 days" },
  { value: "365", label: "Expires in a year" },
];

// The server's limit on a key's name.
const MAX_NAME = 100;

function isExpired(key: ApiKey): boolean {
  return key.expires_at !== null && Date.parse(key.expires_at) <= Date.now();
}

/** "Created Nov 24, 2026 · Last used Nov 25, 2026 · Expires Dec 24, 2026". */
function keyDates(key: ApiKey): string {
  const parts = [
    `Created ${fmtDate(key.created_at)}`,
    key.last_used_at ? `Last used ${fmtDate(key.last_used_at)}` : "Never used",
  ];
  // An expired key says so in its badge.
  if (key.expires_at && !isExpired(key)) parts.push(`Expires ${fmtDate(key.expires_at)}`);
  return parts.join(" · ");
}

/**
 * What outlives the section while Settings is open: switching sections or
 * searching unmounts ApiKeysSetting, but the key just made can't be fetched
 * again, and a create still out must keep the form locked.
 */
export interface ApiKeySession {
  /** The key just made, shown until Settings closes. */
  created: CreatedApiKey | null;
  setCreated: (update: (created: CreatedApiKey | null) => CreatedApiKey | null) => void;
  /** A create is out: no second one until it settles. */
  creating: boolean;
  setCreating: (creating: boolean) => void;
  /** Bumped as Settings closes, so a create that lands later is dropped. */
  generation: RefObject<number>;
}

/** SettingsDialog's hold on the API keys section, forgotten on close. */
export function useApiKeySession(open: boolean, mounted: boolean): ApiKeySession {
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [creating, setCreating] = useState(false);
  const generation = useRef(0);
  // Closing drops whatever create is still out, and unlocks the form.
  useEffect(() => {
    if (open) return;
    generation.current += 1;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCreating(false);
  }, [open]);
  // The key stays on screen through the exit fade, then goes. Opening
  // (a reopen mid-fade too) starts without one.
  useEffect(() => {
    if (!open && mounted) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCreated(null);
  }, [open, mounted]);
  return useMemo(() => ({ created, setCreated, creating, setCreating, generation }), [created, creating]);
}

interface Props {
  session: ApiKeySession;
}

/**
 * The signed-in user's API keys: make one (shown once, to copy), see when
 * each was last used, revoke them. The key itself never comes back after
 * it's made, so the list tells keys apart by name and first characters.
 */
export default function ApiKeysSetting({ session }: Props) {
  const { created, setCreated, creating, setCreating, generation } = session;
  const { me } = useAuth();
  const {
    data: keys,
    error: loadError,
    update,
    reload,
  } = useApiResource<ApiKey[]>(
    (signal) => api.listApiKeys({ signal }),
    "Couldn't load your API keys.",
    { cacheKey: "settings:api-keys" },
  );
  const confirm = useConfirm();
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("0");
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  // Set by a create, so coming back to the section doesn't refocus the key.
  const focusKey = useRef(false);
  const revokeRefs = useRef(new Map<string, HTMLButtonElement>());
  const { copied, flash, reset } = useCopiedFlag(2000);
  const desktopServer = useDesktopConfig()?.backendUrl;
  // The desktop app's pages come from a loopback proxy; scripts call the server.
  const server = (isElectron() ? desktopServer : null) || window.location.origin;

  // Create disables itself as the request goes out; focus goes on to the new
  // key, selected for copying.
  useEffect(() => {
    if (!created || !focusKey.current) return;
    focusKey.current = false;
    keyRef.current?.focus();
  }, [created]);

  // The key just made belongs in the list, whichever mount of this section
  // made it. The list (and its cache) never holds the key itself. A list
  // that hasn't loaded yet, or failed to, loads afresh with the new key in
  // it: adding to nothing would show the new key alone. A list that lands
  // later without it (fetched before it was made) gets it added.
  const unknownList = !keys;
  useEffect(() => {
    if (created && unknownList) void reload();
  }, [created, unknownList, reload]);
  useEffect(() => {
    if (!created || !keys || keys.some((k) => k.id === created.id)) return;
    const { key: _key, ...listed } = created;
    update((current) => current && [listed, ...current.filter((k) => k.id !== listed.id)]);
  }, [created, keys, update]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    // A second submit while one is out would make a second key.
    if (creating || !trimmed) return;
    // Settings closing in the meantime drops the reply: the key it made is
    // listed next time, never shown.
    const at = generation.current;
    setCreating(true);
    setError("");
    try {
      const made = await api.createApiKey({ name: trimmed, expires_in_days: Number(expiry) });
      if (generation.current !== at) return;
      focusKey.current = true;
      setCreated(() => made);
      setName("");
      reset();
    } catch (err) {
      if (generation.current !== at) return;
      setError(errorMessage(err, "Couldn't make the key."));
      nameRef.current?.focus();
    } finally {
      if (generation.current === at) setCreating(false);
    }
  };

  const revoke = async (key: ApiKey) => {
    // The confirm hands focus back to this row's button, which is gone once
    // it's revoked: the next key's takes it instead.
    const list = keys ?? [];
    const at = list.findIndex((k) => k.id === key.id);
    const neighbour = list[at + 1] ?? list[at - 1];
    const revoked = await confirm({
      title: "Revoke this API key?",
      message: "Anything using it stops working right away.",
      subject: {
        art: { icon: KeyIcon },
        name: key.name,
        detail: `${key.prefix}… · ${key.last_used_at ? `Last used ${fmtDate(key.last_used_at)}` : "Never used"}`,
      },
      confirmLabel: "Revoke",
      confirmIcon: TrashIcon,
      busyLabel: "Revoking…",
      errorFallback: "Couldn't revoke the key.",
      action: async () => {
        try {
          await api.deleteApiKey(key.id);
        } catch (err) {
          // Revoked already, from another window.
          if (!(err instanceof ApiError && err.status === 404)) throw err;
        }
        update((list) => list?.filter((k) => k.id !== key.id) ?? null);
        setCreated((c) => (c?.id === key.id ? null : c));
      },
    });
    if (!revoked) return;
    const next = neighbour ? revokeRefs.current.get(neighbour.id) : undefined;
    (next ?? nameRef.current)?.focus();
  };

  return (
    <>
      <SettingRow
        label="API keys"
        description={
          me?.role === "admin"
            ? "Scripts and other programs use a key to call Lumen's API as you, admin rights included. Changing your password revokes every key."
            : "Scripts and other programs use a key to call Lumen's API as you. Changing your password revokes every key."
        }
        error={error || loadError || undefined}
        below={
          <>
            <form className="settings-copy api-key-form" onSubmit={(e) => void create(e)}>
              <input
                ref={nameRef}
                className="input settings-input"
                aria-label="Key name"
                placeholder="Name it after what uses it"
                maxLength={MAX_NAME}
                spellCheck={false}
                value={name}
                readOnly={creating}
                onChange={(e) => setName(e.currentTarget.value)}
              />
              <Select
                variant="minimal"
                aria-label="Expiry"
                value={expiry}
                options={EXPIRY}
                onChange={setExpiry}
                disabled={creating}
              />
              <Button size="sm" type="submit" disabled={creating || !name.trim()}>
                {creating ? "Creating…" : "Create"}
              </Button>
            </form>
            {created && (
              <div className="api-key-created" role="status">
                <div className="settings-copy">
                  <input
                    ref={keyRef}
                    className="input settings-input"
                    aria-label={`New key “${created.name}”`}
                    readOnly
                    value={created.key}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button
                    size="sm"
                    onClick={async () => {
                      if (await copyText(created.key)) flash();
                    }}
                    leadingIcon={
                      copied ? <CheckIcon className="size-3.5" /> : <ClipboardIcon className="size-3.5" />
                    }
                  >
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <p className="settings-row-desc">
                  Copy it now: Lumen won't show it again. Send it as{" "}
                  <span className="font-mono">Authorization: Bearer &lt;key&gt;</span> to{" "}
                  <span className="font-mono">{server}/api</span>.
                </p>
              </div>
            )}
          </>
        }
      />
      {keys?.map((key) => (
        <SettingRow
          key={key.id}
          label={
            <span className="api-key-name">
              <span className="truncate">{key.name}</span>
              {isExpired(key) && <span className="badge">Expired</span>}
            </span>
          }
          description={
            <>
              <span className="font-mono">{key.prefix}…</span> · {keyDates(key)}
            </>
          }
        >
          <Button
            ref={(el) => {
              if (el) revokeRefs.current.set(key.id, el);
              else revokeRefs.current.delete(key.id);
            }}
            size="sm"
            onClick={() => void revoke(key)}
          >
            Revoke
          </Button>
        </SettingRow>
      ))}
    </>
  );
}
