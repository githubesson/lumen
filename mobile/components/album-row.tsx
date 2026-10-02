import { memo } from "react";
import {
  albumArtistName,
  albumSubtitle,
  displayText,
  pluralize,
  type Album,
  type SearchAlbum,
} from "@music-library/core";
import { CoverArt } from "./cover-art";
import { ListRow } from "./list-row";

interface Props<T extends Album | SearchAlbum> {
  album: T;
  /** Receives the same object that was passed in as `album`. */
  onPress: (album: T) => void;
}

const ART_SIZE = 40;

function AlbumRowImpl<T extends Album | SearchAlbum>({ album, onPress }: Props<T>) {
  const title = displayText(album.title);
  const tracks = pluralize(album.track_count, "track");
  return (
    <ListRow
      onPress={() => onPress(album)}
      accessibilityLabel={
        album.artist_name || album.is_compilation
          ? `${title} by ${albumArtistName(album)}, ${tracks}`
          : `${title}, ${tracks}`
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
      title={title}
      subtitle={albumSubtitle(album, { trackCount: false })}
      trailing={tracks}
    />
  );
}

// memo() drops the type parameter; restore it so `onPress` stays typed to the
// row's own album type.
export const AlbumRow = memo(AlbumRowImpl) as typeof AlbumRowImpl;
