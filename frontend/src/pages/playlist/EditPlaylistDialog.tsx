import { FormEvent, useState } from "react";
import { api, errorMessage, type Playlist, type Visibility } from "../../api";
import { Button } from "../../components/Button";
import DialogFooter from "../../components/DialogFooter";
import { DialogShell } from "../../components/DialogShell";
import ErrorBanner from "../../components/ErrorBanner";
import { Field, TextInput } from "../../components/Field";

export default function EditPlaylistDialog({
  open,
  playlist,
  onClose,
  onSaved,
}: {
  open: boolean;
  playlist: Playlist;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(playlist.name);
  const [description, setDescription] = useState(playlist.description ?? "");
  const [visibility, setVisibility] = useState<Visibility>(playlist.visibility);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updatePlaylist(playlist.id, {
        name: name.trim(),
        description,
        visibility,
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Failed to save."));
      setBusy(false);
    }
  };

  return (
    <DialogShell open={open} title="Edit playlist" onClose={onClose} maxWidth={420}>
      <form onSubmit={save} className="overflow-y-auto px-4 py-4" style={{ display: "grid", gap: 14 }}>
        <Field label="Name">
          <TextInput
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>
        <Field label="Description">
          <TextInput
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field label="Visibility">
          <select
            className="input"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as Visibility)}
          >
            <option value="private">Private</option>
            <option value="collaborative">Collaborative</option>
          </select>
        </Field>
        {error && <ErrorBanner message={error} />}
        <DialogFooter bordered={false}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </form>
    </DialogShell>
  );
}
