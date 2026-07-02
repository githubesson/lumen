import { FormEvent, useState } from "react";
import { api, errorMessage, type Playlist, type Visibility } from "../../api";
import { SaveCancelFooter } from "../../components/DialogFooter";
import { DialogShell } from "../../components/DialogShell";
import ErrorBanner from "../../components/ErrorBanner";
import { Field, NativeSelect, TextInput } from "../../components/Field";

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
          <NativeSelect
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as Visibility)}
          >
            <option value="private">Private</option>
            <option value="collaborative">Collaborative</option>
          </NativeSelect>
        </Field>
        {error && <ErrorBanner message={error} />}
        <SaveCancelFooter onCancel={onClose} busy={busy} />
      </form>
    </DialogShell>
  );
}
