import { trackCredits, type TidalStreamQuality, type TidalTrackInfo, type TrackArtist } from "../api";

/**
 * The credit rows of a TIDAL track's info view: Primary artist, Featured and
 * Producers as for any track, then each other role TIDAL credits, in its
 * order. TIDAL's values win; the track's own fill in what TIDAL lacks.
 */
export function tidalTrackCredits(
  track: { artists?: TrackArtist[]; composer?: string },
  info: TidalTrackInfo,
): { label: string; value: string }[] {
  const artists = (role: "main" | "featured") =>
    info.artists
      .filter((artist) => artist.role === role)
      .map((artist) => artist.name)
      .join(", ");
  const roles = new Map<string, { label: string; names: string[] }>();
  for (const credit of info.credits) {
    const key = credit.role.trim().toLowerCase();
    if (!key) continue;
    const entry = roles.get(key) ?? { label: roleLabel(credit.role), names: [] };
    for (const name of credit.names) {
      if (!entry.names.includes(name)) entry.names.push(name);
    }
    roles.set(key, entry);
  }
  const producers = roles.get("producer")?.names.join(", ");
  roles.delete("producer");
  const [primary, featured, ownProducers] = trackCredits(track);
  return [
    { label: primary.label, value: artists("main") || primary.value },
    // TIDAL's split is authoritative once it names a main artist.
    { label: featured.label, value: artists("featured") || (artists("main") ? "—" : featured.value) },
    { label: ownProducers.label, value: producers || ownProducers.value },
    ...[...roles.values()]
      .filter((role) => role.names.length > 0)
      .map((role) => ({ label: role.label, value: role.names.join(", ") })),
  ];
}

/**
 * TIDAL's "Mixing Engineer" as "Mixing engineer", the way the view writes
 * its own labels. Acronyms ("A&R") keep their case.
 */
function roleLabel(role: string): string {
  return role
    .trim()
    .split(/\s+/)
    .map((word, i) => (i > 0 && /^[A-Z][a-z]+$/.test(word) ? word.toLowerCase() : word))
    .join(" ");
}

interface TierAudio {
  format: string;
  quality: string;
  /** Empty when the tier doesn't fix it. */
  bitDepth: string;
  sampleRate: string;
  bitrate: string;
  /** The tier in one phrase, for when it's only a ceiling. */
  summary: string;
}

/** What a stream at `tier` is, as TIDAL defines its tiers. */
function tierAudio(tier: TidalStreamQuality | string | undefined): TierAudio | null {
  switch (tier) {
    case "HI_RES_LOSSLESS":
      return { format: "FLAC", quality: "Hi-Res Lossless", bitDepth: "24-bit", sampleRate: "Up to 192 kHz", bitrate: "", summary: "Hi-Res Lossless (24-bit FLAC)" };
    case "LOSSLESS":
      return { format: "FLAC", quality: "Lossless", bitDepth: "16-bit", sampleRate: "44.1 kHz", bitrate: "", summary: "Lossless (16-bit / 44.1 kHz FLAC)" };
    case "HIGH":
      return { format: "AAC", quality: "Lossy", bitDepth: "", sampleRate: "", bitrate: "320 kbps", summary: "AAC 320 kbps" };
    case "LOW":
      return { format: "AAC", quality: "Lossy", bitDepth: "", sampleRate: "", bitrate: "96 kbps", summary: "AAC 96 kbps" };
    default:
      return null;
  }
}

/**
 * The stream rows of a TIDAL track's info view. The stream this server is
 * serving right now fixes them; without one, only the best tier it would
 * ask for is known, since playback can fall back lower, so that shows as a
 * ceiling.
 */
export function tidalAudioRows(
  info: TidalTrackInfo | null,
): { label: string; value: string; wide?: boolean }[] {
  const streamed = tierAudio(info?.streamed_quality);
  if (streamed) {
    return [
      { label: "Format", value: streamed.format },
      { label: "Quality", value: streamed.quality },
      { label: "Bit depth", value: streamed.bitDepth },
      { label: "Sample rate", value: streamed.sampleRate },
      { label: "Bitrate", value: streamed.bitrate },
    ].filter((row) => row.value);
  }
  const ceiling = tierAudio(info?.max_quality);
  return [{ label: "Quality", value: ceiling ? `Up to ${ceiling.summary}` : "—", wide: !!ceiling }];
}
