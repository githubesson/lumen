import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { getTweaks, isElectron, saveTweaks } from "./platform";

const STORAGE_KEY = "player:sinkId";
const DEFAULT_DEVICE_ID = "default";

interface OutputDevice {
  deviceId: string;
  label: string;
}

interface AudioOutputCtx {
  /** True when the platform exposes `setSinkId` (Chromium-based environments incl. Electron). */
  supported: boolean;
  devices: OutputDevice[];
  /** Selected sinkId. Empty string `""` means the system default. */
  deviceId: string;
  /** Last error from `setSinkId` / `enumerateDevices`, surfaced for the UI. */
  error: string | null;
  /** Persist and apply a new sinkId. */
  selectDevice: (id: string) => Promise<void>;
  /** Re-run `enumerateDevices`. Triggers a one-shot mic grant so labels populate. */
  refresh: () => Promise<void>;
}

const AudioOutputContext = createContext<AudioOutputCtx | null>(null);

interface ProviderProps {
  audioRefs: readonly RefObject<HTMLAudioElement>[];
  children: ReactNode;
}

type AudioElementWithSink = HTMLAudioElement & {
  setSinkId?: (id: string) => Promise<void>;
  sinkId?: string;
};

function isSupported(): boolean {
  if (typeof window === "undefined") return false;
  if (!window.navigator?.mediaDevices?.enumerateDevices) return false;
  return "setSinkId" in HTMLMediaElement.prototype;
}

/**
 * Unlocks `audiooutput` labels by briefly opening a microphone stream.
 * Without a prior `getUserMedia` grant Chromium returns blank labels for
 * non-default devices. In Electron the main-process permission handler
 * auto-approves, so this resolves silently.
 */
async function unlockLabels(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    // Permission denied — we can still list devices, just without labels.
  }
}

async function listOutputs(): Promise<OutputDevice[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === "audiooutput")
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || (d.deviceId === "default" ? "System default" : `Output ${i + 1}`),
    }));
}

export function AudioOutputProvider({ audioRefs, children }: ProviderProps) {
  const supported = useMemo(() => isSupported(), []);
  const [devices, setDevices] = useState<OutputDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(STORAGE_KEY) ?? "";
  });
  const [error, setError] = useState<string | null>(null);
  // Track the desired sinkId separately so we can re-apply after the audio
  // element mounts late (the ref is null on first render).
  const desiredRef = useRef<string>(deviceId);
  // Keep the ref current from an effect: writing refs during render is illegal
  // under concurrent React (a render that is thrown away still mutates it) and
  // is rejected by the React Compiler.
  useEffect(() => {
    desiredRef.current = deviceId;
  }, [deviceId]);

  const applySink = useCallback(
    async (id: string) => {
      const elements = audioRefs
        .map((ref) => ref.current as AudioElementWithSink | null)
        .filter((el): el is AudioElementWithSink => !!el?.setSinkId);
      if (!elements.length) return;
      try {
        await Promise.all(elements.map((el) => el.setSinkId!(id)));
        setError(null);
      } catch (e) {
        const msg = (e as Error).message || String(e);
        setError(msg);
        // If the persisted device disappeared, fall back to the default so
        // the user isn't stuck with silent audio next launch.
        if ((e as DOMException).name === "NotFoundError" && id !== "") {
          setDeviceId("");
          desiredRef.current = "";
          try {
            localStorage.removeItem(STORAGE_KEY);
          } catch {
            // ignore
          }
          await Promise.all(
            elements.map((el) => el.setSinkId!("").catch(() => {})),
          );
        }
      }
    },
    [audioRefs],
  );

  const refresh = useCallback(async () => {
    if (!supported) return;
    try {
      await unlockLabels();
      const list = await listOutputs();
      setDevices(list);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [supported]);

  const selectDevice = useCallback(
    async (id: string) => {
      desiredRef.current = id;
      setDeviceId(id);
      try {
        if (id) localStorage.setItem(STORAGE_KEY, id);
        else localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
      if (isElectron()) {
        void saveTweaks({ audioSinkId: id });
      }
      await applySink(id);
    },
    [applySink],
  );

  // In Electron localStorage is tied to the random proxy port, so the
  // canonical sink id lives in config.json. Load it once at startup.
  useEffect(() => {
    if (!isElectron()) return;
    let cancelled = false;
    getTweaks()
      .then(({ audioSinkId }) => {
        if (cancelled || !audioSinkId) return;
        desiredRef.current = audioSinkId;
        setDeviceId(audioSinkId);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Apply the persisted sinkId once the audio element mounts. The element
  // is owned by `PlayerProvider`, so the ref may resolve a tick after we do.
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    let frame: number | null = null;
    const tryApply = () => {
      frame = null;
      if (cancelled) return;
      if (audioRefs.some((ref) => !ref.current)) {
        frame = requestAnimationFrame(tryApply);
        return;
      }
      const id = desiredRef.current || DEFAULT_DEVICE_ID;
      void applySink(id === DEFAULT_DEVICE_ID ? "" : id);
    };
    tryApply();
    return () => {
      cancelled = true;
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [supported, applySink, audioRefs]);

  // Keep the device list fresh when hardware is plugged/unplugged.
  useEffect(() => {
    if (!supported) return;
    // Device enumeration synchronizes React with the browser media-device API.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const onChange = () => {
      void refresh();
    };
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", onChange);
    };
  }, [supported, refresh]);

  const value = useMemo<AudioOutputCtx>(
    () => ({ supported, devices, deviceId, error, selectDevice, refresh }),
    [supported, devices, deviceId, error, selectDevice, refresh],
  );

  // `value` closes over callbacks that read `audioRefs[n].current`, but only
  // from event handlers — no ref is dereferenced during this render.
  // eslint-disable-next-line react-hooks/refs
  return createElement(AudioOutputContext.Provider, { value }, children);
}

export function useAudioOutput(): AudioOutputCtx {
  const ctx = useContext(AudioOutputContext);
  if (!ctx) throw new Error("useAudioOutput requires AudioOutputProvider");
  return ctx;
}
