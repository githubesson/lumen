import { buildTrackPatch, trackEditForm } from "@music-library/core/metadata-edit";
import { useEditDraft } from "@music-library/core/use-edit-draft";
import { FormEvent, useState, type ReactNode } from "react";
import {
  api,
  errorMessage,
  type TrackDetail,
} from "../../api";
import { SaveCancelFooter } from "../DialogFooter";
import { DialogShell } from "../DialogShell";
import ErrorBanner from "../ErrorBanner";
import LoadingState from "../LoadingState";
import { Field, FieldRow, TextInput } from "../Field";
import { libraryChanged } from "../../lib/events";
import { useTrackDetail } from "../../lib/useTrackDetail";

interface EditTrackProps {
  open: boolean;
  trackId: string | null;
  onClose: () => void;
  onSaved?: (t: TrackDetail) => void;
}

export function EditTrackDialog({
  open,
  trackId,
  onClose,
  onSaved,
}: EditTrackProps) {
  // Loaded afresh on every open, so each load fills a new form.
  const { track, error: loadError } = useTrackDetail(open, trackId);
  return (
    <DialogShell open={open} title="Edit track" onClose={onClose}>
      {track && trackId ? (
        <TrackEditor
          key={track.id}
          trackId={trackId}
          track={track}
          onClose={onClose}
          onSaved={onSaved}
        />
      ) : (
        <TrackForm onSubmit={(e) => e.preventDefault()} onCancel={onClose} busy={false} disabled>
          {loadError ? <ErrorBanner message={loadError} /> : <LoadingState />}
        </TrackForm>
      )}
    </DialogShell>
  );
}

function TrackEditor({
  trackId,
  track,
  onClose,
  onSaved,
}: {
  trackId: string;
  track: TrackDetail;
  onClose: () => void;
  onSaved?: (t: TrackDetail) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only the fields changed from what the form was filled from are sent.
  const { base, draft, setField } = useEditDraft(track, trackEditForm);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateTrack(trackId, buildTrackPatch(base, draft));
      libraryChanged.emit();
      onSaved?.(updated);
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Save failed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <TrackForm onSubmit={submit} onCancel={onClose} busy={busy}>
      <Field label="Title">
        <TextInput
          value={draft.title}
          onChange={(e) => setField("title", e.target.value)}
          required
        />
      </Field>
      <Field
        label="Artists"
        hint="Comma-separated. First is the primary, rest are featured."
      >
        <TextInput
          value={draft.artists}
          onChange={(e) => setField("artists", e.target.value)}
          placeholder="Alice, Bob"
        />
      </Field>
      <FieldRow>
        <Field label="Album">
          <TextInput
            value={draft.albumTitle}
            onChange={(e) => setField("albumTitle", e.target.value)}
            placeholder="Blank to detach"
          />
        </Field>
        <Field
          label="Album artist"
          hint="Leave blank for compilations (Various Artists)."
        >
          <TextInput
            value={draft.albumArtist}
            onChange={(e) => setField("albumArtist", e.target.value)}
          />
        </Field>
      </FieldRow>
      <FieldRow columns={4}>
        <Field label="Year">
          <TextInput
            type="number"
            min={0}
            value={draft.year}
            onChange={(e) => setField("year", e.target.value)}
          />
        </Field>
        <Field label="Genre">
          <TextInput
            value={draft.genre}
            onChange={(e) => setField("genre", e.target.value)}
          />
        </Field>
        <Field label="Track #">
          <TextInput
            type="number"
            min={0}
            value={draft.trackNo}
            onChange={(e) => setField("trackNo", e.target.value)}
          />
        </Field>
        <Field label="Disc #">
          <TextInput
            type="number"
            min={0}
            value={draft.discNo}
            onChange={(e) => setField("discNo", e.target.value)}
          />
        </Field>
      </FieldRow>
      {error && <ErrorBanner message={error} />}
    </TrackForm>
  );
}

function TrackForm({
  onSubmit,
  onCancel,
  busy,
  disabled,
  children,
}: {
  onSubmit: (e: FormEvent) => void;
  onCancel: () => void;
  busy: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <form onSubmit={onSubmit} className="overflow-y-auto px-4 py-4" style={{ display: "grid", gap: 12 }}>
      {children}
      <SaveCancelFooter
        onCancel={onCancel}
        busy={busy}
        disabled={disabled}
        style={{ paddingTop: 8 }}
      />
    </form>
  );
}
