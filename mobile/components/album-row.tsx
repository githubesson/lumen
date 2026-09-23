import { memo } from "react";
import { type Album, type SearchAlbum } from "@music-library/core";
import { CoverArt } from "./cover-art";
import { ListRow } from "./list-row";

interface Props<T extends Album | SearchAlbum> {
  album: T;
  /** Receives the same object that was passed in as `album`. */
  onPress: (album: T) => void;
}

const ART_SIZE = 40;

function AlbumRowImpl<T extends Album | SearchAlbum>({ album, onPress }: Props<T>) {
  return (
    <ListRow
      onPress={() => onPress(album)}
      accessibilityLabel={
        album.artist_name
          ? `${album.title} by ${album.artist_name}, ${album.track_count} tracks`
          : `${album.title}, ${album.track_count} tracks`
      }
      leading={
        <CoverArt
          album={album}
          size={ART_SIZE}
          transitionMs={0}
          priority="low"
          recyclingKey={album.id}
        />
      }
      title={album.title}
      subtitle={[album.artist_name, "source" in album && album.source === "tidal" ? "TIDAL" : null].filter(Boolean).join(" · ")}
      trailing={`${album.track_count} ${album.track_count === 1 ? "track" : "tracks"}`}
    />
  );
}

// memo() drops the type parameter; restore it so `onPress` stays typed to the
// row's own album type.
export const AlbumRow = memo(AlbumRowImpl) as typeof AlbumRowImpl;
