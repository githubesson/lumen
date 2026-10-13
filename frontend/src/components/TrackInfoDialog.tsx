import {
  displayArtists,
  primaryArtistName,
  trackArtUrl,
  type TrackDetail,
} from "../api";
import {
  trackInfoRows,
  trackInfoTidalId,
  type TidalTrackInfoResult,
  type TrackInfoRow,
} from "@music-library/core/tidal/track-info";
import { useState } from "react";
import CoverArt from "./CoverArt";
import { DialogShell } from "./DialogShell";
import { MultiSelect, type MultiSelectOption } from "./MultiSelect";
import { displayText } from "../lib/format";
import { useTidalTrackInfo } from "../lib/useTidalTrackInfo";
import { useTrackDetail } from "../lib/useTrackDetail";

interface Props {
  open: boolean;
  trackId: string | null;
  requestNonce?: number;
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
 */
export function TrackInfoDialog({
  open,
  trackId,
  requestNonce = 0,
  onClose,
}: Props) {
  const { track, error } = useTrackDetail(open, trackId, requestNonce);
  const tidal = useTidalTrackInfo(open, trackInfoTidalId(track), requestNonce);

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
            <Details track={track} tidal={tidal} />
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
 * notes for what TIDAL couldn't supply, then the merged copies' tags.
 */
function Details({
  track,
  tidal,
}: {
  track: TrackDetail;
  /** What came from TIDAL, for a TIDAL track. */
  tidal: TidalTrackInfoResult;
}) {
  const view = trackInfoRows(track, tidal);
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

      {track.aliases && track.aliases.length > 0 && (
        <Versions key={track.id} track={track} />
      )}
    </>
  );
}

interface Version {
  title: string;
  artists: string;
  album: string;
  file: string;
}

const versionFields: { key: Exclude<keyof Version, "file">; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "artists", label: "Artists" },
  { key: "album", label: "Album" },
];

const sameValue = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Versions compares the copies of the track's audio that ingest merged into
 * it, field by field: the copy whose tags are shown, then the others. A
 * dropdown picks which copies sit side by side, starting with the shown one
 * and the first other, so a long list doesn't crowd the view. Each copy keeps
 * its number in the dropdown and in its column's header. A value that matches
 * the shown copy's is faded, so what differs stands out.
 */
function Versions({ track }: { track: TrackDetail }) {
  const shown: Version = {
    title: track.title,
    artists: displayArtists(track),
    album: track.album_title ?? "",
    file: track.metadata_edited
      ? "Edited tags"
      : (track.tags_file_name ?? track.file_name ?? ""),
  };
  const versions: Version[] = [
    shown,
    ...(track.aliases ?? []).map((a) => ({
      title: a.title ?? "",
      artists: a.artist_names ?? "",
      album: a.album_title ?? "",
      file: a.file_name,
    })),
  ];
  // The server sends only the first few of a long list.
  const total = Math.max(track.alias_count ?? 0, versions.length - 1) + 1;
  const [picked, setPicked] = useState<string[]>(["0", "1"]);
  const compared = picked.map(Number).filter((i) => i < versions.length);
  const options: MultiSelectOption[] = versions.map((v, i) => ({
    value: String(i),
    label: versionLabel(v, i),
    detail: [v.title, v.artists].filter(Boolean).join(" · "),
    tag: i === 0 ? "Shown" : undefined,
    icon: <VersionMark n={i + 1} />,
  }));
  return (
    <section className="track-info-section">
      <div className="track-versions-head">
        <h3 className="eyebrow">Versions ({total})</h3>
        <MultiSelect
          aria-label="Versions to compare"
          values={compared.map(String)}
          onChange={setPicked}
          options={options}
          summary={`Comparing ${compared.length} of ${versions.length}`}
        />
      </div>
      <div className="track-versions-caption">
        Same audio, different tags; the fullest is shown. Faded values match
        it.
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
              {compared.map((i) => (
                <th key={i} scope="col" data-shown={i === 0 || undefined}>
                  <span className="version-name">
                    <VersionMark n={i + 1} />
                    <span className="version-file">
                      {versionLabel(versions[i], i)}
                      {i === 0 && <span className="badge">Shown</span>}
                    </span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {versionFields.map(({ key, label }) => (
              <tr key={key}>
                <th scope="row">{label}</th>
                {compared.map((i) => {
                  const same = i > 0 && sameValue(versions[i][key], shown[key]);
                  return (
                    <td
                      key={i}
                      data-shown={i === 0 || undefined}
                      data-same={same || undefined}
                    >
                      {versions[i][key] || "—"}
                      {same && <span className="sr-only"> (same as shown)</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const versionLabel = (v: Version, i: number) => v.file || `Version ${i + 1}`;

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
