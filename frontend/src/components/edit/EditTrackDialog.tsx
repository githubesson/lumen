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
      const patch: Parameters<typeof api.updateTrack>[1] = {};
      if (title !== track.title) patch.title = title;
      const parsedArtists = artists
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const currentArtists = track.artists
        .filter((a) => a.role !== "composer")
        .map((a) => a.name);
      if (parsedArtists.join("\u0000") !== currentArtists.join("\u0000"))
        patch.artists = parsedArtists;
      if (albumTitle !== (track.album_title ?? ""))
        patch.album_title = albumTitle;
      if (albumArtist !== "") patch.album_artist = albumArtist;
      const y = parseInt(year || "0", 10);
      if ((track.year ?? 0) !== y) patch.year = y;
      if ((track.genre ?? "") !== genre) patch.genre = genre;
      const tn = parseInt(trackNo || "0", 10);
      if ((track.track_no ?? 0) !== tn) patch.track_no = tn;
      const dn = parseInt(discNo || "0", 10);
      if ((track.disc_no ?? 0) !== dn) patch.disc_no = dn;

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
