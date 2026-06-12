import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { PhotoIcon, TrashIcon } from "@heroicons/react/16/solid";
import {
  api,
  albumCoverUrl,
  displayArtists,
  errorMessage,
  type Album,
  type TrackDetail,
  type TrackListItem,
} from "../api";
import { Button } from "./Button";
import CoverArt from "./CoverArt";
import DialogFooter from "./DialogFooter";
import { DialogShell } from "./DialogShell";
import SearchInput from "./SearchInput";
import ErrorBanner from "./ErrorBanner";
import LoadingState from "./LoadingState";
import { Field, TextInput } from "./Field";
import { libraryChanged } from "../lib/events";
import { useTrackDetail } from "../lib/useTrackDetail";

/* ——————————————————— track edit dialog ——————————————————— */

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
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
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
            </div>
            <div
              style={{
                display: "grid",
                gap: 12,
                gridTemplateColumns: "1fr 1fr 1fr 1fr",
              }}
            >
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
            </div>
            {error && <ErrorBanner message={error} />}
          </>
        )}
        <FooterRow onCancel={onClose} busy={busy} disabled={!track} />
      </form>
    </DialogShell>
  );
}

/* ——————————————————— move-to-album dialog ——————————————————— */

interface MoveToAlbumProps {
  open: boolean;
  /** The track being moved. Carries album_id so the current album is marked. */
  track: TrackListItem | null;
  onClose: () => void;
  onMoved?: (updated: TrackDetail) => void;
}

/**
 * Admin tool to move a track into an existing album. Unlike the album field in
 * the edit dialog (which upserts an album by name), this assigns the track's
 * album_id directly to a real album row picked from a searchable list — no risk
 * of accidentally spawning a near-duplicate album from a typo.
 */
export function MoveToAlbumDialog({
  open,
  track,
  onClose,
  onMoved,
}: MoveToAlbumProps) {
  const [query, setQuery] = useState("");
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);

  // Reset the search box each time the dialog (re)opens — stale results from
  // the last open, for a different track, would be confusing.
  useEffect(() => {
    if (open) {
      setQuery("");
      setError(null);
      setMovingId(null);
    }
  }, [open]);

  // Debounced album search. The /albums endpoint already does the substring
  // match server-side; this just throttles keystrokes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setAlbums(null);
    const handle = setTimeout(
      () => {
        api
          .listAlbumsPage({ q: query.trim() || undefined, limit: 50 })
          .then((page) => {
            if (!cancelled) setAlbums(page.items);
          })
          .catch((err) => {
            if (cancelled) return;
            setAlbums([]);
            setError(
              errorMessage(err, "Couldn't load albums."),
            );
          });
      },
      query ? 220 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, query]);

  const move = async (album: Album) => {
    if (!track || movingId) return;
    if (album.id === track.album_id) return;
    setMovingId(album.id);
    setError(null);
    try {
      const updated = await api.updateTrack(track.id, { album_id: album.id });
      libraryChanged.emit();
      onMoved?.(updated);
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Move failed."));
      setMovingId(null);
    }
  };

  return (
    <DialogShell open={open} title="Move to album" onClose={onClose}>
      <div className="px-4 py-4" style={{ display: "grid", gap: 12 }}>
        {track && (
          <div style={{ fontSize: 12.5, color: "var(--fg-muted)" }}>
            Moving{" "}
            <span style={{ color: "var(--fg)", fontWeight: 500 }}>
              {track.title}
            </span>
            {track.album_title
              ? ` — currently in ${track.album_title}`
              : " — not in an album yet"}
          </div>
        )}
        <SearchInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search albums"
          autoFocus
        />
        <div
          style={{
            display: "grid",
            gap: 2,
            maxHeight: "44vh",
            overflowY: "auto",
            margin: "0 -4px",
            padding: "0 4px",
          }}
        >
          {albums === null && (
            <div
              className="mono"
              style={{ color: "var(--fg-subtle)", fontSize: 11, padding: 8 }}
            >
              Loading…
            </div>
          )}
          {albums && albums.length === 0 && (
            <div
              className="mono"
              style={{ color: "var(--fg-subtle)", fontSize: 11, padding: 8 }}
            >
              No albums match.
            </div>
          )}
          {albums?.map((a) => {
            const isCurrent = a.id === track?.album_id;
            const busy = movingId === a.id;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => void move(a)}
                disabled={isCurrent || movingId !== null}
                className="album-pick-row"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  padding: 6,
                  borderRadius: "var(--r-md)",
                  border: "1px solid transparent",
                  background: "transparent",
                  textAlign: "left",
                  cursor: isCurrent ? "default" : "pointer",
                  opacity: isCurrent || (movingId !== null && !busy) ? 0.5 : 1,
                }}
              >
                <CoverArt
                  src={a.has_cover ? albumCoverUrl(a.id, 80) : null}
                  seed={a.id}
                  label={a.title}
                  size={40}
                  radius={6}
                  forcePlaceholder={!a.has_cover}
                />
                <div style={{ flex: 1, overflow: "hidden" }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {a.title}
                  </div>
                  <div
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      color: "var(--fg-subtle)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {a.artist_name ||
                      (a.is_compilation ? "Various Artists" : "Unknown artist")}{" "}
                    · {a.track_count}{" "}
                    {a.track_count === 1 ? "track" : "tracks"}
                  </div>
                </div>
                {isCurrent && (
                  <span
                    className="mono"
                    style={{ fontSize: 10, color: "var(--fg-subtle)" }}
                  >
                    Current
                  </span>
                )}
                {busy && (
                  <span
                    className="mono"
                    style={{ fontSize: 10, color: "var(--fg-subtle)" }}
                  >
                    …
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {error && <ErrorBanner message={error} />}
        <div
          style={{ display: "flex", justifyContent: "flex-end", paddingTop: 4 }}
        >
          <Button variant="ghost" onClick={onClose} disabled={movingId !== null}>
            Cancel
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}

/* ——————————————————— album edit dialog ——————————————————— */

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
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
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
        </div>
        {error && <ErrorBanner message={error} />}
        <FooterRow onCancel={onClose} busy={busy} />
      </form>
    </DialogShell>
  );
}

/* ——————————————————— bits ——————————————————— */

function FooterRow({
  onCancel,
  busy,
  disabled,
}: {
  onCancel: () => void;
  busy: boolean;
  disabled?: boolean;
}) {
  return (
    <DialogFooter bordered={false} style={{ paddingTop: 8 }}>
      <Button variant="ghost" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
      <Button type="submit" variant="primary" disabled={busy || disabled}>
        {busy ? "Saving…" : "Save"}
      </Button>
    </DialogFooter>
  );
}

