import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorMessage, type Visibility } from "../api";
import { Button } from "../components/Button";
import { Field, TextInput } from "../components/Field";
import ErrorBanner from "../components/ErrorBanner";
import PageHeader from "../components/PageHeader";
import RadioCardOption from "../components/RadioCardOption";

export default function PlaylistNew() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const p = await api.createPlaylist({ name: name.trim(), description, visibility });
      navigate(`/playlists/${p.id}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err, "Failed to create playlist."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="view">
      <PageHeader title="New playlist" />
      <p style={{ color: "var(--fg-muted)", fontSize: 13, margin: "0 0 28px", maxWidth: "60ch" }}>
        Playlists are private by default. Collaborative ones let you invite other
        users as viewers or editors.
      </p>

      <form
        onSubmit={onSubmit}
        style={{ display: "grid", gap: 16, maxWidth: 480 }}
      >
        <Field label="Name">
          <TextInput
            autoFocus
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>
        <Field label="Description" hint="Optional">
          <TextInput
            name="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 8 }}>
          <legend
            className="mono"
            style={{
              fontSize: 10,
              color: "var(--fg-subtle)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              padding: 0,
              marginBottom: 4,
            }}
          >
            Visibility
          </legend>
          <RadioCardOption
            name="visibility"
            value="private"
            checked={visibility === "private"}
            onChange={() => setVisibility("private")}
            label="Private"
            description="Only you can see or edit this playlist."
          />
          <RadioCardOption
            name="visibility"
            value="collaborative"
            checked={visibility === "collaborative"}
            onChange={() => setVisibility("collaborative")}
            label="Collaborative"
            description="Invited users can view or edit, per-role."
          />
        </fieldset>

        {error && <ErrorBanner message={error} />}

        <div style={{ display: "flex", gap: 8 }}>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Creating…" : "Create playlist"}
          </Button>
          <Button variant="ghost" onClick={() => navigate(-1)}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

