import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorMessage } from "../api";
import { useAuth } from "../context/Auth";
import { Button } from "../components/Button";
import CenteredCard from "../components/CenteredCard";
import ErrorBanner from "../components/ErrorBanner";
import { Field, TextInput } from "../components/Field";

export default function ForceReset() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const forced = me?.must_reset_password ?? false;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await api.resetPassword(current, next);
      await refresh();
      navigate("/", { replace: true });
    } catch (err) {
      setError(errorMessage(err, "Reset failed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CenteredCard
      title={forced ? "Set a new password" : "Change password"}
      intro={
        forced
          ? "You'll need to choose a new password before continuing."
          : undefined
      }
    >
      <form onSubmit={onSubmit} className="grid gap-5">
        <Field label="Current password">
          <TextInput
            type="password"
            autoComplete="current-password"
            name="current"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </Field>

        <Field label="New password" hint="At least 8 characters.">
          <TextInput
            type="password"
            autoComplete="new-password"
            name="new"
            minLength={8}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
          />
        </Field>

        <Field label="Confirm new password">
          <TextInput
            type="password"
            autoComplete="new-password"
            name="confirm"
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </Field>

        {error && <ErrorBanner message={error} />}

        <Button type="submit" variant="primary" size="md" disabled={busy} className="w-full">
          {busy ? "Saving…" : "Save password"}
        </Button>
      </form>
    </CenteredCard>
  );
}
