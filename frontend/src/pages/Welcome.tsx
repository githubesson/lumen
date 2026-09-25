import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowLeft as ArrowLeftIcon, CircleCheck as CheckIcon } from "lucide-react";
import { Button } from "../components/Button";
import { Field, TextInput } from "../components/Field";
import SettingRow from "../components/SettingRow";
import Switch from "../components/Switch";
import { testDesktopServer, updateDesktopConfig, useDesktopConfig } from "../lib/desktopConfig";

type Step = "welcome" | "server" | "preferences";
const STEPS: Step[] = ["welcome", "server", "preferences"];
const LOCAL_SERVER = "http://localhost:8080";

interface Prefs {
  discordEnabled: boolean;
  alwaysOnTop: boolean;
  fh6RadioEnabled: boolean;
}

/**
 * Desktop app setup, shown in place of sign-in. `first-run` walks through a
 * welcome, the server and a few preferences, then saves them in one go;
 * `change` (from the sign-in screen) is only the server step. Saving a new
 * server reloads the window onto that server's sign-in page.
 */
export default function Welcome({
  mode,
  onCancel,
}: {
  mode: "first-run" | "change";
  onCancel?: () => void;
}) {
  const config = useDesktopConfig();
  const [step, setStep] = useState<Step>(mode === "change" ? "server" : "welcome");
  const [address, setAddress] = useState(mode === "change" ? (config?.backendUrl ?? "") : "");
  // Set once a server answered; what gets saved.
  const [server, setServer] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Prefs>({
    discordEnabled: config?.discordEnabled ?? true,
    alwaysOnTop: config?.alwaysOnTop ?? false,
    fh6RadioEnabled: config?.fh6RadioEnabled ?? false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(step);

  // Each new step is a new screen: move focus to its heading so keyboard and
  // screen reader users start at the top. The first screen and the server
  // step autofocus their own control instead.
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    if (step !== "server") headingRef.current?.focus();
  }, [step]);

  const save = async (backendUrl: string, extra: Partial<Prefs>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await updateDesktopConfig({ backendUrl, ...extra });
      if (!result.ok) {
        setError(result.error);
        setBusy(false);
      } else if (!result.changed) {
        // Same server as before: nothing reloads, so just step back out.
        setBusy(false);
        onCancel?.();
      }
      // Otherwise the window is reloading; stay busy until it does.
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
      setBusy(false);
    }
  };

  const connect = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    let result: Awaited<ReturnType<typeof testDesktopServer>>;
    try {
      result = await testDesktopServer(address);
    } catch (cause) {
      result = { ok: false, error: cause instanceof Error ? cause.message : "Could not check that server." };
    }
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      return;
    }
    setAddress(result.url);
    if (mode === "change") {
      await save(result.url, {});
      return;
    }
    setServer(result.url);
    setBusy(false);
    setStep("preferences");
  };

  const back = () => {
    setError(null);
    setStep(STEPS[STEPS.indexOf(step) - 1]);
  };

  const stepNumber = STEPS.indexOf(step) + 1;

  return (
    <div className="welcome">
      <div className="welcome-drag" aria-hidden="true" />
      <main className="welcome-card" aria-labelledby="welcome-title">
        {mode === "first-run" && (
          <div
            className="welcome-progress"
            role="progressbar"
            aria-label="Setup progress"
            aria-valuemin={1}
            aria-valuemax={STEPS.length}
            aria-valuenow={stepNumber}
            aria-valuetext={`Step ${stepNumber} of ${STEPS.length}`}
          >
            {STEPS.map((s, i) => (
              <span key={s} data-done={i < stepNumber || undefined} />
            ))}
          </div>
        )}

        {step === "welcome" && (
          <div className="welcome-step welcome-intro" key="welcome">
            <div className="brand-mark welcome-mark">L</div>
            <h1 id="welcome-title" ref={headingRef} tabIndex={-1}>
              Welcome to Lumen
            </h1>
            <p className="welcome-lead">
              Your music library, on your desktop. Connect to your Lumen server and pick a few
              preferences. It takes about a minute.
            </p>
            <div className="welcome-actions">
              <Button variant="primary" autoFocus onClick={() => setStep("server")}>
                Get started
              </Button>
            </div>
          </div>
        )}

        {step === "server" && (
          <form className="welcome-step" key="server" onSubmit={(e) => void connect(e)} noValidate>
            <h1 id="welcome-title" ref={headingRef} tabIndex={-1}>
              {mode === "change" ? "Change server" : "Connect to your server"}
            </h1>
            <p className="welcome-lead">
              Enter the address you use to open Lumen in a browser.
              {mode === "change" && " Switching servers signs you out of this one."}
            </p>
            <div className="welcome-field">
              <Field label="Server address" error={error ?? undefined}>
                <TextInput
                  autoFocus
                  placeholder="music.example.com"
                  autoComplete="url"
                  spellCheck={false}
                  value={address}
                  // Read-only rather than disabled, so focus stays here to retry.
                  readOnly={busy}
                  onChange={(e) => {
                    setAddress(e.target.value);
                    setError(null);
                  }}
                />
              </Field>
              <p className="welcome-hint">
                Running Lumen on this computer?{" "}
                <button
                  type="button"
                  className="welcome-link"
                  disabled={busy}
                  onClick={() => {
                    setAddress(LOCAL_SERVER);
                    setError(null);
                  }}
                >
                  Use {LOCAL_SERVER}
                </button>
              </p>
            </div>
            <div className="welcome-actions">
              {mode === "change" ? (
                <Button onClick={onCancel} disabled={busy}>
                  Cancel
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  leadingIcon={<ArrowLeftIcon className="size-4" aria-hidden="true" />}
                  onClick={back}
                  disabled={busy}
                >
                  Back
                </Button>
              )}
              <Button type="submit" variant="primary" disabled={busy || !address.trim()}>
                {busy ? "Connecting…" : mode === "change" ? "Switch server" : "Continue"}
              </Button>
            </div>
          </form>
        )}

        {step === "preferences" && server && (
          <div className="welcome-step" key="preferences">
            <h1 id="welcome-title" ref={headingRef} tabIndex={-1}>
              A few preferences
            </h1>
            <p className="welcome-connected">
              <CheckIcon className="size-4" aria-hidden="true" />
              Connected to <span className="mono">{new URL(server).host}</span>
            </p>
            <div className="welcome-prefs">
              <PrefRow
                label="Discord status"
                description="Show what you're listening to. Needs the Discord app running."
                checked={prefs.discordEnabled}
                onChange={(v) => setPrefs((p) => ({ ...p, discordEnabled: v }))}
              />
              <PrefRow
                label="Stay on top"
                description="Keep Lumen above other windows."
                checked={prefs.alwaysOnTop}
                onChange={(v) => setPrefs((p) => ({ ...p, alwaysOnTop: v }))}
              />
              <PrefRow
                label="Lumen Radio for FH6"
                description="Adds the Forza Horizon 6 radio installer and controls to the sidebar."
                checked={prefs.fh6RadioEnabled}
                onChange={(v) => setPrefs((p) => ({ ...p, fh6RadioEnabled: v }))}
              />
            </div>
            <p className="welcome-note">You can change these any time in Settings.</p>
            {error && (
              <p className="welcome-error" role="alert">
                {error}
              </p>
            )}
            <div className="welcome-actions">
              <Button
                variant="ghost"
                leadingIcon={<ArrowLeftIcon className="size-4" aria-hidden="true" />}
                onClick={back}
                disabled={busy}
              >
                Back
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void save(server, prefs)}>
                {busy ? "Finishing…" : "Finish setup"}
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function PrefRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <SettingRow id={id} label={label} description={description}>
      <Switch
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-desc`}
        checked={checked}
        onChange={onChange}
      />
    </SettingRow>
  );
}
