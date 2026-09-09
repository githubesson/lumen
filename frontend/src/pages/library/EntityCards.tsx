import {
  albumCoverUrl,
  resolveCoverUrl,
  type Album,
  type Artist,
  type SearchAlbum,
  type SearchArtist,
} from "../../api";
import CoverArt from "../../components/CoverArt";
import { displayText, pluralize } from "../../lib/format";

export function AlbumCard({
  album: a,
  onOpen,
}: {
  album: Album | SearchAlbum;
  onOpen: (id: string) => void;
}) {
  return (
    <button type="button" className="card" onClick={() => onOpen(a.id)}>
      <CoverArt
        className="card-art"
        src={
          "cover_url" in a && a.cover_url
            ? resolveCoverUrl(a.cover_url)
            : a.has_cover
              ? albumCoverUrl(a.id)
              : null
        }
        seed={a.id}
        label={a.title}
        forcePlaceholder={!("cover_url" in a && a.cover_url) && !a.has_cover}
      />
      <div>
        <div className="card-title">{displayText(a.title)}</div>
        <div className="card-sub">
          {displayText(
            a.artist_name ||
              (a.is_compilation ? "Various Artists" : "Unknown artist"),
          )}{" "}
          · {pluralize(a.track_count, "track")}
          {"source" in a && a.source === "tidal" && " · TIDAL"}
        </div>
      </div>
    </button>
  );
}

export function ArtistCard({
  artist: a,
  onOpen,
}: {
  artist: Artist | SearchArtist;
  onOpen: (id: string, name?: string) => void;
}) {
  return (
    <button type="button" className="card" onClick={() => onOpen(a.id, a.name)}>
      <CoverArt
        className="card-art"
        src={
          "cover_url" in a && a.cover_url ? resolveCoverUrl(a.cover_url) : null
        }
        seed={a.id}
        label={a.name}
        radius={999}
        forcePlaceholder={!("cover_url" in a && a.cover_url)}
      />
      <div style={{ textAlign: "center" }}>
        <div className="card-title">{displayText(a.name)}</div>
        <div className="card-sub">
          {"source" in a && a.source === "tidal"
            ? "TIDAL artist"
            : pluralize(a.track_count, "track")}
          {a.album_count > 0 && <> · {pluralize(a.album_count, "album")}</>}
        </div>
      </div>
    </button>
  );
}
