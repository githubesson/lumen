import {
  api,
  displayArtists,
  errorMessage,
  primaryArtistName,
  SEARCH_DEBOUNCE_MS,
  trackArtUrl,
  type TrackDetail,
  type TrackListItem,
} from "../api";
import {
  trackInfoRows,
  trackInfoTidalId,
  type TidalTrackInfoResult,
  type TrackInfoRow,
} from "@music-library/core/tidal/track-info";
import { formatBitrate, formatDurationMs } from "@music-library/core/format";
import { useDebouncedValue } from "@music-library/core/use-debounced-value";
import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import CoverArt from "./CoverArt";
import { DialogShell } from "./DialogShell";
import ErrorBanner from "./ErrorBanner";
import { MultiSelect, type MultiSelectOption } from "./MultiSelect";
import SearchInput from "./SearchInput";
import { libraryChanged } from "../lib/events";
import { displayText } from "../lib/format";
import { useTidalTrackInfo } from "../lib/useTidalTrackInfo";
import { useTrackDetail } from "../lib/useTrackDetail";

interface Props {
  open: boolean;
  trackId: string | null;
  requestNonce?: number;
  /** The viewer is an admin, who may link and unlink a track's files. */
  canManage?: boolean;
  onClose: () => void;
}

/**
 * TrackInfoDialog is a read-only metadata view for a single track. Fetches the
 * full TrackDetail on open so the server-side enriched fields (bitrate, sample
 * rate, other versions from dedup hits, etc.) are visible in one place. Deliberately
 * separate from EditTrackDialog so non-admins can see the same information
 * without accidentally opening an editor they can't submit.
 *
 * Laid out landscape: the cover, title, artists and album take the left third,
 * and every other field fills the right two thirds, which scroll on their own.
 *
 * A TIDAL track's row stores little, so its fields also come live from TIDAL
 * (credits, release date, stream quality). If TIDAL can't answer, the view
 * shows what the row has.
 *
 * Admins can link other library files of the same song from here; the group
 * then shows the fullest tags and plays the best file.
 */
export function TrackInfoDialog({
  open,
  trackId,
  requestNonce = 0,
  canManage = false,
  onClose,
}: Props) {
  const { track: fetched, error } = useTrackDetail(open, trackId, requestNonce);
  // Linking answers with the group's shown track, which can be another track
  // than the one opened. It stands in for the fetched one until a reopen.
  const openedAs = `${trackId}:${requestNonce}`;
  const [relinked, setRelinked] = useState<{
    openedAs: string;
    track: TrackDetail;
    /** Counts links and unlinks, so focus can follow each. */
    n: number;
  } | null>(null);
  const current = open && relinked?.openedAs === openedAs ? relinked : null;
  const track = current ? current.track : fetched;
  const tidal = useTidalTrackInfo(open, trackInfoTidalId(track), requestNonce);
  const canLink = canManage && track?.source === "local" && !track.owned;

  return (
    <DialogShell open={open} title="Track info" onClose={onClose} maxWidth={880}>
      <div className="track-info">
        <Summary track={track} />
        <div className="track-info-details">
          {error ? (
            <div style={{ color: "var(--destructive)" }}>{error}</div>
          ) : !track || tidal.loading ? (
            <div style={{ color: "var(--muted-foreground)" }}>Loading…</div>
          ) : (
            <Details
              track={track}
              tidal={tidal}
              canLink={canLink}
              relinks={current?.n ?? 0}
              onRelinked={(t) =>
                setRelinked((r) => ({ openedAs, track: t, n: (r?.n ?? 0) + 1 }))
              }
            />
          )}
        </div>
      </div>
    </DialogShell>
  );
}

/** The left third: artwork and the lines a player shows for the track. */
function Summary({ track }: { track: TrackDetail | null }) {
  return (
    <div className="track-info-summary">
      {track ? (
        <CoverArt
          className="track-info-cover"
          src={trackArtUrl(track, 512)}
          label={track.title}
        />
      ) : (
        <div className="track-info-cover cover-art" aria-hidden="true" />
      )}
      {track && (
        <div className="track-info-heading">
          <div className="track-info-title">{displayText(track.title)}</div>
          <div className="track-info-artist">
            {displayArtists(track) || primaryArtistName(track)}
          </div>
          {track.album_title && (
            <div className="track-info-album">{displayText(track.album_title)}</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Credits, Release and Audio as core lays them out for both clients, with
 * notes for what TIDAL couldn't supply, then the other copies' tags.
 */
function Details({
  track,
  tidal,
  canLink,
  relinks,
  onRelinked,
}: {
  track: TrackDetail;
  /** What came from TIDAL, for a TIDAL track. */
  tidal: TidalTrackInfoResult;
  /** The viewer may link and unlink files of this track. */
  canLink: boolean;
  /** How many links and unlinks this opening has seen. */
  relinks: number;
  onRelinked: (track: TrackDetail) => void;
}) {
  const view = trackInfoRows(track, tidal);
  const hasVersions = !!track.aliases?.length || !!track.linked?.length;
  return (
    <>
      {view.note && <p className="track-info-note">{view.note}</p>}

      {view.sections.map((section) => (
        <Section key={section.key} label={section.label}>
          <Fields>
            {section.rows.map((row) => (
              <Field key={row.label} row={row} />
            ))}
          </Fields>
          {section.note && <p className="track-info-note">{section.note}</p>}
        </Section>
      ))}

      {(hasVersions || canLink) && (
        <Versions
          key={track.id}
          track={track}
          canLink={canLink}
          relinks={relinks}
          onRelinked={onRelinked}
        />
      )}
    </>
  );
}

interface Version {
  title: string;
  artists: string;
  album: string;
  file: string;
  /** Container and bitrate, for comparing linked files. */
  format?: string;
  bitrate?: string;
  /** A linked track, which can be unlinked. */
  linkedId?: string;
  shown?: boolean;
  plays?: boolean;
}

type VersionField = Exclude<keyof Version, "file" | "linkedId" | "shown" | "plays">;

const tagFields: { key: VersionField; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "artists", label: "Artists" },
  { key: "album", label: "Album" },
];
const audioFields: { key: VersionField; label: string }[] = [
  { key: "format", label: "Format" },
  { key: "bitrate", label: "Bitrate" },
];

const sameValue = (a = "", b = "") =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** "WAV" for a file name ending in .wav, else the format the server read. */
function fileFormat(fileName: string, format?: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1];
  return ext ? ext.toUpperCase() : (format ?? "");
}

/**
 * Versions compares the other copies of the track field by field: the copy
 * whose tags are shown, then the files linked with it as the same song, then
 * the copies of its audio that ingest merged into it. A dropdown picks which
 * copies sit side by side, starting with the shown one and the one that
 * plays (or the first other), so a long list doesn't crowd the view. Each
 * copy keeps its number in the dropdown and in its column's header. A value
 * that matches the first copy's is faded, so what differs stands out.
 *
 * Admins link another library file of the song here, and unlink one.
 */
function Versions({
  track,
  canLink,
  relinks,
  onRelinked,
}: {
  track: TrackDetail;
  canLink: boolean;
  relinks: number;
  onRelinked: (track: TrackDetail) => void;
}) {
  const ownId = track.db_track_id ?? track.id;
  const own = track.linked?.find((l) => l.id === ownId);
  const ownAudio = own && {
    format: fileFormat(own.file_name, own.format),
    bitrate: formatBitrate(own.bitrate),
  };
  const first: Version = {
    title: track.title,
    artists: displayArtists(track),
    album: track.album_title ?? "",
    file: track.metadata_edited
      ? "Edited tags"
      : (track.tags_file_name ?? track.file_name ?? ""),
    ...ownAudio,
    shown: !track.linked_to,
    plays: own?.plays,
  };
  const versions: Version[] = [
    first,
    ...(track.linked ?? [])
      .filter((l) => l.id !== ownId)
      .map((l) => ({
        title: l.title,
        artists: l.artist_names ?? "",
        album: l.album_title ?? "",
        file: l.file_name,
        format: fileFormat(l.file_name, l.format),
        bitrate: formatBitrate(l.bitrate),
        linkedId: l.id,
        shown: l.shown,
        plays: l.plays,
      })),
    // Copies of the first one's audio.
    ...(track.aliases ?? []).map((a) => ({
      title: a.title ?? "",
      artists: a.artist_names ?? "",
      album: a.album_title ?? "",
      file: a.file_name,
      ...ownAudio,
    })),
  ];
  const linked = !!track.linked?.length;
  const fields = linked ? [...tagFields, ...audioFields] : tagFields;
  // The server sends only the first few of a long list of copies.
  const aliasCount = track.aliases?.length ?? 0;
  const total = versions.length + Math.max(0, (track.alias_count ?? 0) - aliasCount);
  const playing = versions.findIndex((v, i) => i > 0 && v.plays);
  const [picked, setPicked] = useState<string[]>(["0", String(playing > 0 ? playing : 1)]);
  const compared = picked.map(Number).filter((i) => i < versions.length);
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const linkButton = useRef<HTMLButtonElement>(null);
  const [cancels, setCancels] = useState(0);
  // A link, an unlink or a cancelled search removes the control that was
  // used, so focus goes back to "Link a file" rather than out of the dialog.
  useEffect(() => {
    if (relinks || cancels) linkButton.current?.focus();
  }, [relinks, cancels]);

  const relinked = (updated: TrackDetail) => {
    libraryChanged.emit();
    setLinking(false);
    onRelinked(updated);
  };
  const unlink = async (id: string) => {
    if (unlinking) return;
    setUnlinking(id);
    setError(null);
    try {
      relinked(await api.unlinkTrack(id));
    } catch (err) {
      setError(errorMessage(err, "Couldn't unlink the file."));
    } finally {
      setUnlinking(null);
    }
  };

  const options: MultiSelectOption[] = versions.map((v, i) => ({
    value: String(i),
    label: versionLabel(v, i),
    detail: [v.title, v.artists, v.format].filter(Boolean).join(" · "),
    tag: v.shown ? "Shown" : v.plays ? "Plays" : undefined,
    icon: <VersionMark n={i + 1} />,
  }));
  return (
    <section className="track-info-section">
      <div className="track-versions-head">
        <h3 className="eyebrow">
          {versions.length > 1 ? `Versions (${total})` : "Versions"}
        </h3>
        <div className="track-versions-actions">
          {versions.length > 1 && (
            <MultiSelect
              aria-label="Versions to compare"
              values={compared.map(String)}
              onChange={setPicked}
              options={options}
              summary={`Comparing ${compared.length} of ${versions.length}`}
            />
          )}
          {canLink && !linking && (
            <Button ref={linkButton} size="sm" onClick={() => setLinking(true)}>
              Link a file
            </Button>
          )}
        </div>
      </div>
      {linking && (
        <VersionLinker
          track={track}
          exclude={new Set([ownId, ...(track.linked ?? []).map((l) => l.id)])}
          onLinked={relinked}
          onCancel={() => {
            setLinking(false);
            setCancels((n) => n + 1);
          }}
        />
      )}
      {error && <ErrorBanner message={error} />}
      {versions.length > 1 && (
        <>
          <div className="track-versions-caption">
            {linked
              ? `Files of the same song: the fullest tags show and the best file plays. Faded values match ${versions[0].shown ? "the shown file" : "the first"}.`
              : "Same audio, different tags; the fullest is shown. Faded values match it."}
            {total > versions.length &&
              ` Listing the first ${versions.length} of ${total}.`}
          </div>
          <div className="track-versions">
            <table style={{ minWidth: 72 + compared.length * 136 }}>
              <colgroup>
                <col style={{ width: 72 }} />
              </colgroup>
              <thead>
                <tr>
                  <td />
                  {compared.map((i) => {
                    const v = versions[i];
                    return (
                      <th key={i} scope="col" data-shown={v.shown || undefined}>
                        <span className="version-name">
                          <VersionMark n={i + 1} />
                          <span className="version-file">
                            {versionLabel(v, i)}
                            {v.shown && <span className="badge">Shown</span>}
                            {v.plays && !v.shown && <span className="badge">Plays</span>}
                          </span>
                        </span>
                        {canLink && v.linkedId && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="version-unlink"
                            aria-label={`Unlink ${versionLabel(v, i)}`}
                            disabled={unlinking !== null}
                            onClick={() => void unlink(v.linkedId!)}
                          >
                            {unlinking === v.linkedId ? "Unlinking…" : "Unlink"}
                          </Button>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {fields.map(({ key, label }) => (
                  <tr key={key}>
                    <th scope="row">{label}</th>
                    {compared.map((i) => {
                      const same = i > 0 && sameValue(versions[i][key], versions[0][key]);
                      return (
                        <td
                          key={i}
                          data-shown={versions[i].shown || undefined}
                          data-same={same || undefined}
                        >
                          {versions[i][key] || "—"}
                          {same && (
                            <span className="sr-only">
                              {versions[0].shown ? " (same as shown)" : " (same as the first)"}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

const versionLabel = (v: Version, i: number) => v.file || `Version ${i + 1}`;

/** The title without a trailing "(v2)" or "[Remix]", to find other versions by. */
const searchableTitle = (title: string) =>
  displayText(title).replace(/(\s*[([][^)\]]*[)\]])+\s*$/, "").trim() ||
  displayText(title);

/** A library track another file can be linked with: a shared local one. */
const linkable = (item: TrackListItem) =>
  (!item.source || item.source === "local") && !item.owned && !item.unavailable;

/**
 * VersionLinker finds another library file of the song, by its title to
 * begin with, and links it with the track.
 */
function VersionLinker({
  track,
  exclude,
  onLinked,
  onCancel,
}: {
  track: TrackDetail;
  /** The tracks already in the group. */
  exclude: Set<string>;
  onLinked: (track: TrackDetail) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState(() => searchableTitle(track.title));
  const q = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const [results, setResults] = useState<{ q: string; items: TrackListItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkingId, setLinkingId] = useState<string | null>(null);

  useEffect(() => {
    if (!q) return;
    const controller = new AbortController();
    api
      .listTracks({ q, limit: 20, signal: controller.signal })
      .then((items) => setResults({ q, items }))
      .catch((err) => {
        if (!controller.signal.aborted) {
          setResults({ q, items: [] });
          setError(errorMessage(err, "Couldn't search the library."));
        }
      });
    return () => controller.abort();
  }, [q]);

  const items =
    q && results?.q === q
      ? results.items.filter((i) => linkable(i) && !exclude.has(i.db_track_id ?? i.id))
      : null;

  const link = async (item: TrackListItem) => {
    if (linkingId) return;
    setLinkingId(item.id);
    setError(null);
    try {
      onLinked(await api.linkTrack(track.db_track_id ?? track.id, item.db_track_id ?? item.id));
    } catch (err) {
      setError(errorMessage(err, "Couldn't link the file."));
      setLinkingId(null);
    }
  };

  return (
    // Escape anywhere in here cancels the search; DialogShell leaves it to
    // this (data-owns-escape) instead of closing the dialog.
    <div
      className="version-linker"
      data-owns-escape
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        // Like Cancel, which is disabled until a link request settles.
        if (linkingId === null) onCancel();
      }}
    >
      <div className="version-linker-search">
        <SearchInput
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setError(null);
          }}
          onFocus={(e) => e.currentTarget.select()}
          placeholder="Find another file of this song"
          aria-label="Find another file of this song"
          autoFocus
        />
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={linkingId !== null}>
          Cancel
        </Button>
      </div>
      {error && <ErrorBanner message={error} />}
      {q && (
        <div className="version-linker-results" aria-busy={items === null}>
          {items === null ? (
            <div className="version-linker-empty">Searching…</div>
          ) : items.length === 0 ? (
            <div className="version-linker-empty">No other library tracks match.</div>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="version-linker-item"
                disabled={linkingId !== null}
                onClick={() => void link(item)}
              >
                <span className="version-linker-title">{displayText(item.title)}</span>
                <span className="version-linker-meta">
                  {[
                    displayText(item.artist),
                    displayText(item.album_title),
                    formatDurationMs(item.duration_ms, ""),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {linkingId === item.id && (
                  <span className="version-linker-meta">Linking…</span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A version's number, the same in the dropdown and its column's header.
 * Screen readers hear it too: copies can share a file name and tags, and
 * then the number is all that tells them apart.
 */
function VersionMark({ n }: { n: number }) {
  return (
    <>
      <span className="version-mark" aria-hidden="true">
        {n}
      </span>
      <span className="sr-only">Version {n}: </span>
    </>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="track-info-section">
      <h3 className="eyebrow">{label}</h3>
      {children}
    </section>
  );
}

function Fields({ children }: { children: React.ReactNode }) {
  return <dl className="track-info-fields">{children}</dl>;
}

/** One labelled value. A row kept while empty shows a faded dash. */
function Field({ row }: { row: TrackInfoRow }) {
  return (
    <div data-wide={row.wide || undefined}>
      <dt>{row.label}</dt>
      <dd data-empty={row.empty || undefined}>{row.value}</dd>
    </div>
  );
}
