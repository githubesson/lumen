import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { PhotoIcon, TrashIcon } from "@heroicons/react/16/solid";
import { api, albumCoverUrl, errorMessage, type Album } from "../../api";
import { Button } from "../Button";
import CoverArt from "../CoverArt";
import { SaveCancelFooter } from "../DialogFooter";
import { DialogShell } from "../DialogShell";
import ErrorBanner from "../ErrorBanner";
import { Field, FieldRow, TextInput } from "../Field";
import { libraryChanged } from "../../lib/events";

interface EditAlbumProps {
  open: boolean;
  album: Album | null;
  onClose: () => void;
  onSaved?: (a: Album) => void;
}

export function EditAlbumDialog({
  open,
  album,
  onClose,
  onSaved,
}: EditAlbumProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [albumArtist, setAlbumArtist] = useState("");
  const [year, setYear] = useState("");
  const [isCompilation, setIsCompilation] = useState(false);

  // Cover art is handled separately from the metadata form: it's a multipart
  // upload that applies immediately, so it gets its own busy flag. `hasCover`
  // tracks the live state and `coverNonce` cache-busts the preview <img> since
  // the cover URL is stable even when the underlying image changes.
  const [hasCover, setHasCover] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverNonce, setCoverNonce] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || !album) return;
    setError(null);
    setTitle(album.title);
    setAlbumArtist(album.artist_name ?? "");
    setYear(album.release_year ? String(album.release_year) : "");
    setIsCompilation(album.is_compilation);
    setHasCover(album.has_cover);
    setCoverNonce(0);
    // Re-init only when the dialog opens or switches to a different album —
    // not on every `album` object identity change. A cover edit calls
    // onSaved() with a fresh Album, and re-running this on that would wipe any
    // in-progress (unsaved) metadata edits the user had typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, album?.id]);

  const coverPreviewSrc =
    hasCover && album
      ? `${albumCoverUrl(album.id)}${coverNonce ? `?v=${coverNonce}` : ""}`
      : null;

  const onPickCover = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the user re-pick the same file later
    if (!file || !album) return;
    setCoverBusy(true);
    setError(null);
    try {
      const updated = await api.setAlbumCover(album.id, file);
      setHasCover(updated.has_cover);
      setCoverNonce(Date.now());
      libraryChanged.emit();
      onSaved?.(updated);
    } catch (err) {
      setError(errorMessage(err, "Cover upload failed."));
    } finally {
      setCoverBusy(false);
    }
  };

  const onRemoveCover = async () => {
    if (!album) return;
    setCoverBusy(true);
    setError(null);
    try {
      const updated = await api.removeAlbumCover(album.id);
      setHasCover(updated.has_cover);
      setCoverNonce(Date.now());
      libraryChanged.emit();
      onSaved?.(updated);
    } catch (err) {
      setError(errorMessage(err, "Couldn't remove the cover."));
    } finally {
      setCoverBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!album) return;
    setBusy(true);
    setError(null);
    try {
      const patch: Parameters<typeof api.updateAlbum>[1] = {};
      if (title !== album.title) patch.title = title;
      if (albumArtist !== (album.artist_name ?? "")) patch.album_artist = albumArtist;
      const y = parseInt(year || "0", 10);
      if ((album.release_year ?? 0) !== y) patch.release_year = y;
      if (isCompilation !== album.is_compilation) patch.is_compilation = isCompilation;
      const updated = await api.updateAlbum(album.id, patch);
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
    <DialogShell open={open} title="Edit album" onClose={onClose}>
      <form
        onSubmit={submit}
        className="overflow-y-auto px-4 py-4"
        style={{ display: "grid", gap: 12 }}
      >
        <Field label="Cover art">
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            {album && (
              <CoverArt
                src={coverPreviewSrc}
                seed={album.id}
                label={title || album.title}
                size={72}
                radius={8}
                forcePlaceholder={!coverPreviewSrc}
              />
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <Button
                variant="ghost"
                onClick={() => fileInputRef.current?.click()}
                disabled={coverBusy}
              >
                <PhotoIcon className="size-3.5" />
                {coverBusy ? "Working…" : hasCover ? "Replace cover" : "Upload cover"}
              </Button>
              {hasCover && (
                <Button
                  variant="ghost"
                  onClick={() => void onRemoveCover()}
                  disabled={coverBusy}
                >
                  <TrashIcon className="size-3.5" />
                  Remove cover
                </Button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              hidden
              onChange={(e) => void onPickCover(e)}
            />
          </div>
        </Field>
        <Field label="Title">
          <TextInput
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </Field>
        <Field
          label="Album artist"
          hint="Leave blank and check Compilation for Various Artists."
        >
          <TextInput
            value={albumArtist}
            onChange={(e) => setAlbumArtist(e.target.value)}
          />
        </Field>
        <FieldRow>
          <Field label="Year">
            <TextInput
              type="number"
              min={0}
              value={year}
              onChange={(e) => setYear(e.target.value)}
            />
          </Field>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              alignSelf: "end",
              paddingBottom: 8,
            }}
          >
            <input
              type="checkbox"
              checked={isCompilation}
              onChange={(e) => setIsCompilation(e.target.checked)}
              style={{ accentColor: "var(--accent)" }}
            />
            <span style={{ fontSize: 13 }}>Compilation</span>
          </label>
        </FieldRow>
        {error && <ErrorBanner message={error} />}
        <SaveCancelFooter onCancel={onClose} busy={busy} style={{ paddingTop: 8 }} />
      </form>
    </DialogShell>
  );
}
