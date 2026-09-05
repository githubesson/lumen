import { buildTrackPatch } from "@music-library/core/metadata-edit";
import { FormEvent, useEffect, useState } from "react";
import {
  api,
  displayArtists,
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
  const { track, error: loadError } = useTrackDetail(open, trackId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // form state
  const [title, setTitle] = useState("");
  const [artists, setArtists] = useState("");
  const [albumTitle, setAlbumTitle] = useState("");
  const [albumArtist, setAlbumArtist] = useState("");
  const [year, setYear] = useState("");
  const [genre, setGenre] = useState("");
  const [trackNo, setTrackNo] = useState("");
  const [discNo, setDiscNo] = useState("");

  // Seed the form once the track loads.
  useEffect(() => {
    if (!track) return;
    // The form draft intentionally snapshots the selected track.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null);
    setTitle(track.title);
    setArtists(displayArtists(track));
    // album_artist isn't on TrackDetail — default to empty (compilations
    // stay "Various Artists"; otherwise the server keeps the primary artist).
    setAlbumArtist("");
    setAlbumTitle(track.album_title ?? "");
    setYear(track.year ? String(track.year) : "");
    setGenre(track.genre ?? "");
    setTrackNo(track.track_no ? String(track.track_no) : "");
    setDiscNo(track.disc_no ? String(track.disc_no) : "");
  }, [track]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!trackId || !track) return;
    setBusy(true);
    setError(null);
    try {
      // Only send fields the user actually touched — detect by comparing to
      // initial values. Simpler: just always send fields that changed from
      // the loaded value.
      const patch = buildTrackPatch(track, { title, artists, albumTitle, albumArtist, year, genre, trackNo, discNo });
      const updated = await api.updateTrack(trackId, patch);
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
    <DialogShell open={open} title="Edit track" onClose={onClose}>
      <form onSubmit={submit} className="overflow-y-auto px-4 py-4" style={{ display: "grid", gap: 12 }}>
        {!track && !error && !loadError && <LoadingState />}
        {loadError && <ErrorBanner message={loadError} />}
        {track && (
          <>
            <Field label="Title">
              <TextInput
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </Field>
            <Field
              label="Artists"
              hint="Comma-separated. First is the primary, rest are featured."
            >
              <TextInput
                value={artists}
                onChange={(e) => setArtists(e.target.value)}
                placeholder="Alice, Bob"
              />
            </Field>
            <FieldRow>
              <Field label="Album">
                <TextInput
                  value={albumTitle}
                  onChange={(e) => setAlbumTitle(e.target.value)}
                  placeholder="Blank to detach"
                />
              </Field>
              <Field
                label="Album artist"
                hint="Leave blank for compilations (Various Artists)."
              >
                <TextInput
                  value={albumArtist}
                  onChange={(e) => setAlbumArtist(e.target.value)}
                />
              </Field>
            </FieldRow>
            <FieldRow columns={4}>
              <Field label="Year">
                <TextInput
                  type="number"
                  min={0}
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                />
              </Field>
              <Field label="Genre">
                <TextInput
                  value={genre}
                  onChange={(e) => setGenre(e.target.value)}
                />
              </Field>
              <Field label="Track #">
                <TextInput
                  type="number"
                  min={0}
                  value={trackNo}
                  onChange={(e) => setTrackNo(e.target.value)}
                />
              </Field>
              <Field label="Disc #">
                <TextInput
                  type="number"
                  min={0}
                  value={discNo}
                  onChange={(e) => setDiscNo(e.target.value)}
                />
              </Field>
            </FieldRow>
            {error && <ErrorBanner message={error} />}
          </>
        )}
        <SaveCancelFooter
          onCancel={onClose}
          busy={busy}
          disabled={!track}
          style={{ paddingTop: 8 }}
        />
      </form>
    </DialogShell>
  );
}
