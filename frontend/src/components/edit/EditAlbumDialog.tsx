import { buildAlbumPatch } from "@music-library/core/metadata-edit";
import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { Image as PhotoIcon, Trash2 as TrashIcon } from "lucide-react";
import { api, albumCoverUrl, errorMessage, type Album } from "../../api";
import { Button } from "../Button";
import CoverArt from "../CoverArt";
import { SaveCancelFooter } from "../DialogFooter";
import { DialogShell } from "../DialogShell";
import ErrorBanner from "../ErrorBanner";
import { Field, FieldRow, TextInput } from "../Field";
import { libraryChanged } from "../../lib/events";
import { useFormDraft } from "../../lib/useFormDraft";

type AlbumDraft = Parameters<typeof buildAlbumPatch>[1];

const EMPTY_ALBUM_DRAFT: AlbumDraft = {
  title: "",
  albumArtist: "",
  year: "",
  isCompilation: false,
};

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
  const { draft, setField, resetDraft } = useFormDraft(EMPTY_ALBUM_DRAFT);

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
    // The form draft intentionally snapshots the selected album on open.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null);
    resetDraft({
      title: album.title,
      albumArtist: album.artist_name ?? "",
      year: album.release_year ? String(album.release_year) : "",
      isCompilation: album.is_compilation,
    });
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
      const patch = buildAlbumPatch(album, draft);
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
                label={draft.title || album.title}
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
            value={draft.title}
            onChange={(e) => setField("title", e.target.value)}
            required
          />
        </Field>
        <Field
          label="Album artist"
          hint="Leave blank and check Compilation for Various Artists."
        >
          <TextInput
            value={draft.albumArtist}
            onChange={(e) => setField("albumArtist", e.target.value)}
          />
        </Field>
        <FieldRow>
          <Field label="Year">
            <TextInput
              type="number"
              min={0}
              value={draft.year}
              onChange={(e) => setField("year", e.target.value)}
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
              checked={draft.isCompilation}
              onChange={(e) => setField("isCompilation", e.target.checked)}
              style={{ accentColor: "var(--primary)" }}
            />
            <span style={{ fontSize: 14 }}>Compilation</span>
          </label>
        </FieldRow>
        {error && <ErrorBanner message={error} />}
        <SaveCancelFooter onCancel={onClose} busy={busy} style={{ paddingTop: 8 }} />
      </form>
    </DialogShell>
  );
}
