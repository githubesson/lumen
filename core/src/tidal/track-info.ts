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

export interface TidalStreamAudio {
  format: string;
  quality: string;
  /** Empty when the quality doesn't fix it. */
  bitDepth: string;
  sampleRate: string;
  bitrate: string;
}

/** What a stream at `quality` is, as TIDAL defines its tiers. */
export function tidalStreamAudio(
  quality: TidalStreamQuality | string | undefined,
): TidalStreamAudio | null {
  switch (quality) {
    case "HI_RES_LOSSLESS":
      return { format: "FLAC", quality: "Hi-Res Lossless", bitDepth: "24-bit", sampleRate: "Up to 192 kHz", bitrate: "" };
    case "LOSSLESS":
      return { format: "FLAC", quality: "Lossless", bitDepth: "16-bit", sampleRate: "44.1 kHz", bitrate: "" };
    case "HIGH":
      return { format: "AAC", quality: "Lossy", bitDepth: "", sampleRate: "", bitrate: "320 kbps" };
    case "LOW":
      return { format: "AAC", quality: "Lossy", bitDepth: "", sampleRate: "", bitrate: "96 kbps" };
    default:
      return null;
  }
}
