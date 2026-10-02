import { displayArtists, primaryArtistName, trackCredits, type TrackDetail } from "../api";
import {
  formatBitrate,
  formatDurationMs,
  formatSampleRate,
} from "@music-library/core/format";
import { DialogShell } from "./DialogShell";
import { fmtBytes } from "../lib/format";
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
 */
export function TrackInfoDialog({
  open,
  trackId,
  requestNonce = 0,
  onClose,
}: Props) {
  const { track, error } = useTrackDetail(open, trackId, requestNonce);

  const body = error ? (
    <div
      className="dialog-scroll"
      style={{ padding: 16, color: "var(--destructive)" }}
    >
      {error}
    </div>
  ) : !track ? (
    <div
      className="dialog-scroll"
      style={{ padding: 16, color: "var(--muted-foreground)", fontSize: 14 }}
    >
      Loading…
    </div>
  ) : (
    <div className="dialog-scroll" style={{ padding: 16, fontSize: 14 }}>
      <HeaderBlock track={track} />

      {track.aliases && track.aliases.length > 0 && (
        <Versions track={track} />
      )}

      <Section label="Identity">
        <Field k="Title" v={track.title} />
        {trackCredits(track).map((credit) => (
          <Field key={credit.label} k={credit.label} v={credit.value} />
        ))}
        <Field k="Album" v={track.album_title || "—"} />
        <Field k="Year" v={track.year ? String(track.year) : "—"} />
        <Field k="Genre" v={track.genre || "—"} />
        {track.comments && <Field k="Comments" v={track.comments} />}
        <Field
          k="Track · Disc"
          v={
            track.track_no || track.disc_no
              ? `${track.track_no ?? "—"} · ${track.disc_no ?? "—"}`
              : "—"
          }
        />
      </Section>

      <Section label="Audio">
        <Field k="Format" v={track.format || "—"} />
        <Field k="Bitrate" v={formatBitrate(track.bitrate)} />
        <Field k="Sample rate" v={formatSampleRate(track.sample_rate)} />
        <Field k="Channels" v={track.channels ? String(track.channels) : "—"} />
        <Field k="Duration" v={formatDurationMs(track.duration_ms, "—")} />
        <Field k="File size" v={fmtBytes(track.file_size)} />
        {track.file_name && <Field k="File" v={track.file_name} />}
      </Section>
    </div>
  );

  return (
    <DialogShell open={open} title="Track info" onClose={onClose}>
      {body}
    </DialogShell>
  );
}

function HeaderBlock({ track }: { track: TrackDetail }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 16, fontWeight: 600 }}>{track.title}</div>
      <div style={{ color: "var(--muted-foreground)" }}>
        {primaryArtistName(track)}
        {track.album_title ? ` · ${track.album_title}` : ""}
      </div>
    </div>
  );
}

interface Version {
  title: string;
  artists: string;
  album: string;
  file: string;
}

const versionFields: { key: keyof Version; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "artists", label: "Artists" },
  { key: "album", label: "Album" },
  { key: "file", label: "File" },
];

const sameValue = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Versions compares every copy of the track's audio that ingest merged into
 * it, field by field: the copy whose tags are shown, then the others. An
 * alternate's value that matches the shown one is faded, so what differs
 * stands out.
 */
function Versions({ track }: { track: TrackDetail }) {
  const shown: Version = {
    title: track.title,
    artists: displayArtists(track),
    album: track.album_title ?? "",
    file: track.metadata_edited
      ? "Edited"
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
  return (
    <Section label={`Versions (${total})`}>
      <div className="track-versions-caption">
        Same audio, different tags; the fullest is shown. Faded values match
        it.
        {total > versions.length &&
          ` Showing ${versions.length} of ${total}.`}
      </div>
      <div className="track-versions">
        <table style={{ minWidth: 72 + versions.length * 128 }}>
          <colgroup>
            <col style={{ width: 72 }} />
          </colgroup>
          <thead>
            <tr>
              <td />
              {versions.map((_, i) => (
                <th key={i} scope="col" data-shown={i === 0 ? "" : undefined}>
                  {i === 0 ? (
                    <span className="badge">Shown</span>
                  ) : (
                    `Version ${i + 1}`
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {versionFields.map(({ key, label }) => (
              <tr key={key}>
                <th scope="row">{label}</th>
                {versions.map((v, i) => {
                  const same = i > 0 && sameValue(v[key], shown[key]);
                  return (
                    <td
                      key={i}
                      data-shown={i === 0 ? "" : undefined}
                      data-same={same ? "" : undefined}
                      title={same ? "Same as the shown version" : undefined}
                    >
                      {v[key] || "—"}
                      {same && <span className="sr-only"> (same as shown)</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
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
    <div style={{ marginBottom: 14 }}>
      <div
        className="eyebrow"
        style={{
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div style={{ display: "grid", gap: 4 }}>{children}</div>
    </div>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "110px 1fr",
        gap: 10,
        alignItems: "baseline",
      }}
    >
      <div style={{ color: "var(--muted-foreground)", fontSize: 12 }}>{k}</div>
      <div style={{ color: "var(--foreground)", wordBreak: "break-all" }}>
        {v}
      </div>
    </div>
  );
}
