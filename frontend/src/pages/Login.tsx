import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/Auth";
import { ApiError } from "../api";
import { Button } from "../components/Button";
import CenteredCard from "../components/CenteredCard";
import ErrorBanner from "../components/ErrorBanner";
import { Field, TextInput } from "../components/Field";
import { electron, getDesktopConfig, isElectron } from "../lib/platform";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverHost, setServerHost] = useState("");

  useEffect(() => {
    if (!isElectron()) return;
    void getDesktopConfig()?.then((cfg) => {
      if (!cfg?.backendUrl) return;
      try {
        setServerHost(new URL(cfg.backendUrl).host);
      } catch {
        setServerHost(cfg.backendUrl);
      }
    });
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username, password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Invalid username or password."
          : "Sign in failed. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <CenteredCard title="Sign in">
      <form onSubmit={onSubmit} className="grid gap-5">
        <Field label="Username">
          <TextInput
            autoFocus
            autoComplete="username"
            name="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </Field>

        <Field label="Password">
          <TextInput
            type="password"
            autoComplete="current-password"
            name="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>

        {error && <ErrorBanner message={error} />}

        <Button type="submit" variant="primary" size="md" disabled={busy} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>

        <p className="text-center text-sm/5 text-[var(--fg-subtle)]">
          Accounts are invite-only.
        </p>

        {isElectron() && (
          <p className="text-center text-sm/5 text-[var(--fg-subtle)]">
            {serverHost && (
              <>
                Server: <span className="font-medium">{serverHost}</span>
                {" · "}
              </>
            )}
            <button
              type="button"
              onClick={() => void electron()?.openSettings()}
              className="underline underline-offset-2 hover:text-[var(--fg)]"
            >
              Change server
            </button>
          </p>
        )}
      </form>
    </CenteredCard>
  );
}
