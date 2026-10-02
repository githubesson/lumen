import {
  albumArtUrl,
  artistImageUrl,
  type Album,
  type Artist,
  type SearchAlbum,
  type SearchArtist,
} from "../../api";
import { albumSubtitle, artistSubtitle } from "@music-library/core/entity-labels";
import { searchEntityTarget, type EntityTarget } from "@music-library/core/entity-target";
import CoverArt from "../../components/CoverArt";
import { displayText } from "../../lib/format";

export function AlbumCard({
  album: a,
  onOpen,
}: {
  album: Album | SearchAlbum;
  onOpen: (target: EntityTarget) => void;
}) {
  const src = albumArtUrl(a, 384);
  return (
    <button type="button" className="card" onClick={() => onOpen(searchEntityTarget(a))}>
      <CoverArt
        className="card-art"
        src={src}
        label={a.title}
        forcePlaceholder={!src}
      />
      <div>
        <div className="card-title">{displayText(a.title)}</div>
        <div className="card-sub">{albumSubtitle(a)}</div>
      </div>
    </button>
  );
}

export function ArtistCard({
  artist: a,
  onOpen,
}: {
  artist: Artist | SearchArtist;
  onOpen: (target: EntityTarget, name?: string) => void;
}) {
  const src = artistImageUrl(a, [], 384);
  return (
    <button type="button" className="card" onClick={() => onOpen(searchEntityTarget(a), a.name)}>
      <CoverArt
        className="card-art"
        src={src}
        label={a.name}
        radius={999}
        forcePlaceholder={!src}
      />
      <div style={{ textAlign: "center" }}>
        <div className="card-title">{displayText(a.name)}</div>
        <div className="card-sub">{artistSubtitle(a)}</div>
      </div>
    </button>
  );
}
