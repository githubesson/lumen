import { useState, type FormEvent, type RefObject } from "react";
import { ImageUp as ImageUpIcon, Trash2 as TrashIcon } from "lucide-react";
import { errorMessage, type Playlist, type Visibility } from "../../api";
import { Button } from "../../components/Button";
import ErrorBanner from "../../components/ErrorBanner";
import { TextInput } from "../../components/Field";
import Section from "../../components/Section";
import { Select, type SelectOption } from "../../components/Select";
import SettingRow from "../../components/SettingRow";
import Switch from "../../components/Switch";
import { pluralize } from "../../lib/format";

const VISIBILITY_OPTIONS: SelectOption<Visibility>[] = [
  { value: "private", label: "Private" },
  { value: "collaborative", label: "Collaborative" },
];

export interface PlaylistDetails {
  name: string;
  description: string;
  visibility: Visibility;
}

// Names are saved trimmed, so a trailing space isn't a pending edit.
const sameDetails = (a: PlaylistDetails, b: PlaylistDetails) =>
  a.name.trim() === b.name.trim() &&
  a.description === b.description &&
  a.visibility === b.visibility;

/**
 * The playlist's Settings tab: cover, details and deletion for the owner,
 * TIDAL auto-download for admins. The text details save together; the cover
 * and the switch apply as soon as they change.
 */
export default function PlaylistSettingsPanel({
  hidden,
  playlist,
  isOwner,
  isAdmin,
  nameInputRef,
  onSaveDetails,
  savingCover,
  onPickCover,
  onRemoveCover,
  autoDownload,
  savingAutoDownload,
  queuedTidal,
  onToggleAutoDownload,
  onDelete,
}: {
  /** Kept mounted behind the other tabs, so unsaved edits survive a switch. */
  hidden: boolean;
  playlist: Playlist;
  isOwner: boolean;
  isAdmin: boolean;
  nameInputRef: RefObject<HTMLInputElement>;
  /** Resolves once saved; rejects with the error to show. */
  onSaveDetails: (details: PlaylistDetails) => Promise<void>;
  savingCover: boolean;
  onPickCover: () => void;
  onRemoveCover: () => void;
  autoDownload: boolean;
  savingAutoDownload: boolean;
  queuedTidal: number;
  onToggleAutoDownload: () => void;
  onDelete: () => void;
}) {
  const saved: PlaylistDetails = {
    name: playlist.name,
    description: playlist.description ?? "",
    visibility: playlist.visibility,
  };
  // Null until edited, so a reload of the playlist shows through.
  const [draft, setDraft] = useState<PlaylistDetails | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const values = draft ?? saved;
  const dirty =
    draft !== null &&
    (draft.name !== saved.name ||
      draft.description !== saved.description ||
      draft.visibility !== saved.visibility);
  const edit = (patch: Partial<PlaylistDetails>) => setDraft({ ...values, ...patch });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const name = values.name.trim();
    if (!name) {
      setError("Give the playlist a name.");
      return;
    }
    const submitted = { ...values, name };
    setBusy(true);
    setError(null);
    try {
      await onSaveDetails(submitted);
      // Typing can carry on while the save is out; keep anything newer than
      // what was sent.
      setDraft((current) =>
        current === null || sameDetails(current, submitted) ? null : current,
      );
    } catch (err) {
      setError(errorMessage(err, "Failed to save."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="playlist-settings" hidden={hidden}>
      {isOwner && (
        <Section title="Details">
          <form className="surface playlist-settings-card" onSubmit={save}>
            <SettingRow
              id="playlist-cover"
              label="Cover"
              description={
                playlist.custom_cover
                  ? "Your image. JPEG, PNG or WebP."
                  : "The first track's art, until you choose an image."
              }
            >
              <div className="playlist-settings-buttons">
                {playlist.custom_cover && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={savingCover}
                    onClick={onRemoveCover}
                  >
                    Remove
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={savingCover}
                  onClick={onPickCover}
                  leadingIcon={<ImageUpIcon className="size-3.5" />}
                >
                  {savingCover ? "Uploading…" : "Choose image"}
                </Button>
              </div>
            </SettingRow>
            <SettingRow
              id="playlist-name"
              label="Name"
              below={
                <TextInput
                  ref={nameInputRef}
                  aria-labelledby="playlist-name-label"
                  value={values.name}
                  onChange={(e) => edit({ name: e.target.value })}
                  required
                />
              }
            />
            <SettingRow
              id="playlist-description"
              label="Description"
              below={
                <TextInput
                  aria-labelledby="playlist-description-label"
                  placeholder="Optional"
                  value={values.description}
                  onChange={(e) => edit({ description: e.target.value })}
                />
              }
            />
            <SettingRow
              id="playlist-visibility"
              label="Visibility"
              description={
                values.visibility === "collaborative"
                  ? "People you invite can see it, and editors can add tracks."
                  : "Only you can see it."
              }
            >
              <Select
                variant="minimal"
                aria-labelledby="playlist-visibility-label"
                value={values.visibility}
                options={VISIBILITY_OPTIONS}
                onChange={(visibility) => edit({ visibility })}
              />
            </SettingRow>
            {error && <ErrorBanner message={error} />}
            <div className="playlist-settings-actions">
              {dirty && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setDraft(null);
                    setError(null);
                  }}
                >
                  Discard
                </Button>
              )}
              <Button type="submit" variant="primary" disabled={!dirty || busy}>
                Save
              </Button>
            </div>
          </form>
        </Section>
      )}

      {isAdmin && (
        <Section title="Downloads">
          <div className="surface playlist-settings-card">
            <SettingRow
              id="playlist-tidal"
              label="Save TIDAL tracks to the library"
              description={
                <>
                  Downloads this playlist's TIDAL tracks to the server, now and
                  as they're added.
                  {autoDownload && queuedTidal > 0 &&
                    ` ${pluralize(queuedTidal, "track")} still queued.`}
                </>
              }
            >
              <Switch
                checked={autoDownload}
                disabled={savingAutoDownload}
                onChange={onToggleAutoDownload}
                aria-labelledby="playlist-tidal-label"
                aria-describedby="playlist-tidal-desc"
              />
            </SettingRow>
          </div>
        </Section>
      )}

      {isOwner && (
        <Section title="Danger zone">
          <div className="surface playlist-settings-card">
            <SettingRow
              label="Delete playlist"
              description={
                playlist.visibility === "collaborative"
                  ? "Removes it for you and everyone you've invited. This can't be undone."
                  : "This can't be undone."
              }
            >
              <Button
                variant="danger"
                size="sm"
                onClick={onDelete}
                leadingIcon={<TrashIcon className="size-3.5" />}
              >
                Delete
              </Button>
            </SettingRow>
          </div>
        </Section>
      )}
    </div>
  );
}
