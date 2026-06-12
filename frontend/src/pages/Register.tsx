import { FormEvent, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, errorMessage, type InviteCheck } from "../api";
import { useAuth } from "../context/Auth";
import { Button } from "../components/Button";
import CenteredCard from "../components/CenteredCard";
import ErrorBanner from "../components/ErrorBanner";
import { Field, TextInput } from "../components/Field";

export default function Register() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [check, setCheck] = useState<InviteCheck | null>(null);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { setMe } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!token) {
      setCheck({ valid: false });
      setChecking(false);
      return;
    }
    api
      .checkInvite(token)
      .then(setCheck)
      .catch(() => setCheck({ valid: false }))
      .finally(() => setChecking(false));
  }, [token]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const me = await api.register(token, username, password);
      setMe(me);
      navigate("/", { replace: true });
    } catch (err) {
      setError(errorMessage(err, "Registration failed."));
    } finally {
      setBusy(false);
    }
  };

  if (checking) {
    return (
      <CenteredCard title="Checking invite">
        <p className="text-center text-sm/5 text-neutral-500 dark:text-neutral-400">
          One moment…
        </p>
      </CenteredCard>
    );
  }

  if (!check?.valid) {
    return (
      <CenteredCard
        title="Invite unavailable"
        intro="This link is missing, expired, or already used."
      >
        <p className="text-center text-sm/5 text-neutral-500 dark:text-neutral-400">
          Ask an admin for a fresh invite.
        </p>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard
      title="Create account"
      intro={
        <>
          Registering as{" "}
          <span className="inline-flex items-center gap-x-1 rounded-full bg-neutral-900 px-2 py-0.5 font-medium text-white dark:bg-neutral-100 dark:text-neutral-900">
            {check.target_role}
          </span>
          .
        </>
      }
    >
      <form onSubmit={onSubmit} className="grid gap-5">
        <Field label="Username" hint="2 characters or more.">
          <TextInput
            autoFocus
            autoComplete="username"
            name="username"
            minLength={2}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </Field>

        <Field label="Password" hint="At least 8 characters.">
          <TextInput
            type="password"
            autoComplete="new-password"
            name="password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>

        {error && <ErrorBanner message={error} />}

        <Button type="submit" variant="primary" size="md" disabled={busy} className="w-full">
          {busy ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </CenteredCard>
  );
}
