import { type TrackDetail } from "../api";
import { DialogShell } from "./DialogShell";
import { fmtBytes, fmtDurationMs } from "../lib/format";
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
 * rate, aliases from dedup hits, etc.) are visible in one place. Deliberately
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
      style={{ padding: 16, color: "var(--danger-fg)" }}
    >
      {error}
    </div>
  ) : !track ? (
    <div
      className="dialog-scroll"
      style={{ padding: 16, color: "var(--fg-subtle)", fontSize: 12.5 }}
    >
      Loading…
    </div>
  ) : (
    <div className="dialog-scroll" style={{ padding: 16, fontSize: 12.5 }}>
      <HeaderBlock track={track} />

      <Section label="Identity">
        <Field k="Title" v={track.title} />
        <Field k="Primary artist" v={artistNames(track, "primary") || "—"} />
        <Field k="Featured" v={artistNames(track, "featured") || "—"} />
        <Field k="Producers" v={producerNames(track) || "—"} />
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
        <Field
          k="Bitrate"
          v={track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : "—"}
        />
        <Field
          k="Sample rate"
          v={track.sample_rate ? `${track.sample_rate} Hz` : "—"}
        />
        <Field k="Channels" v={track.channels ? String(track.channels) : "—"} />
        <Field k="Duration" v={fmtDurationMs(track.duration_ms)} />
        <Field k="File size" v={fmtBytes(track.file_size)} />
      </Section>

      {track.aliases && track.aliases.length > 0 && (
        <Section label={`Also known as (${track.aliases.length})`}>
          <div style={{ display: "grid", gap: 10 }}>
            {track.aliases.map((a, i) => (
              <div
                key={i}
                className="surface-inset"
                style={{ padding: 10, display: "grid", gap: 4 }}
              >
                {a.title && <Field k="Title" v={a.title} mono={false} />}
                {a.artist_names && (
                  <Field k="Artists" v={a.artist_names} mono={false} />
                )}
                {a.album_title && (
                  <Field k="Album" v={a.album_title} mono={false} />
                )}
                <Field k="File" v={a.file_path} mono />
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );

  return (
    <DialogShell open={open} title="Track info" onClose={onClose}>
      {body}
    </DialogShell>
  );
}

function HeaderBlock({ track }: { track: TrackDetail }) {
  const primary = track.artists.find((a) => a.role === "primary")?.name;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 16, fontWeight: 600 }}>{track.title}</div>
      <div style={{ color: "var(--fg-muted)" }}>
        {primary ?? "Unknown artist"}
        {track.album_title ? ` · ${track.album_title}` : ""}
      </div>
    </div>
  );
}

function artistNames(track: TrackDetail, role: string): string {
  return track.artists
    .filter((a) => a.role === role)
    .map((a) => a.name)
    .join(", ");
}

function producerNames(track: TrackDetail): string {
  return track.composer?.trim() || artistNames(track, "composer");
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
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--fg-subtle)",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div style={{ display: "grid", gap: 4 }}>{children}</div>
    </div>
  );
}

function Field({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "110px 1fr",
        gap: 10,
        alignItems: "baseline",
      }}
    >
      <div style={{ color: "var(--fg-subtle)", fontSize: 11 }}>{k}</div>
      <div
        className={mono ? "mono" : undefined}
        style={{
          color: "var(--fg)",
          wordBreak: "break-all",
          fontSize: mono ? 11 : undefined,
        }}
      >
        {v}
      </div>
    </div>
  );
}
