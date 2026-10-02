import {
  inviteCheckErrorMessage,
  registrationErrorMessage,
} from "@music-library/core/auth/errors";
import { validateRegistrationInput } from "@music-library/core/auth/validation";
import { FormEvent, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, type InviteCheck } from "../api";
import { useAuth } from "../context/Auth";
import { Button } from "../components/Button";
import CenteredCard from "../components/CenteredCard";
import ErrorBanner from "../components/ErrorBanner";
import { Field, TextInput } from "../components/Field";

// Tagged with its token, so a result never answers for a different link.
type InviteCheckResult =
  | { token: string; check: InviteCheck; error?: never }
  | { token: string; check?: never; error: string };

export default function Register() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [checkResult, setCheckResult] = useState<InviteCheckResult | null>(null);
  const [checkAttempt, setCheckAttempt] = useState(0);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { setMe } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    // A failed check says nothing about the invite, so it isn't shown as a
    // dead one.
    api.checkInvite(token).then(
      (check) => {
        if (!cancelled) setCheckResult({ token, check });
      },
      (err) => {
        if (!cancelled) {
          setCheckResult({ token, error: inviteCheckErrorMessage(err) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token, checkAttempt]);

  const result = checkResult?.token === token ? checkResult : null;
  const check: InviteCheck | null = token ? (result?.check ?? null) : { valid: false };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const validation = validateRegistrationInput(username, password);
    if (!validation.valid) {
      setError(validation.usernameError ?? validation.passwordError);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const me = await api.register(token, validation.username, password);
      setMe(me);
      navigate("/", { replace: true });
    } catch (err) {
      setError(registrationErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (result?.error) {
    return (
      <CenteredCard title="Couldn't check invite" intro={result.error}>
        <Button
          variant="primary"
          size="md"
          className="w-full"
          onClick={() => {
            setCheckResult(null);
            setCheckAttempt((n) => n + 1);
          }}
        >
          Try again
        </Button>
      </CenteredCard>
    );
  }

  if (!check) {
    return (
      <CenteredCard title="Checking invite">
        <p className="text-center text-sm/5 text-(--muted-foreground)">
          One moment…
        </p>
      </CenteredCard>
    );
  }

  if (!check.valid) {
    return (
      <CenteredCard
        title="Invite unavailable"
        intro="This link is missing, expired, or already used."
      >
        <p className="text-center text-sm/5 text-(--muted-foreground)">
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
          <span className="inline-flex items-center gap-x-1 rounded-full bg-(--foreground) px-2 py-0.5 font-medium text-(--background)">
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
