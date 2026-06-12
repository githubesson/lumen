import { memo } from "react";
import { type Album } from "@music-library/core";
import { CoverArt } from "./cover-art";
import { ListRow } from "./list-row";

interface Props {
  album: Album;
  onPress: (album: Album) => void;
}

const ART_SIZE = 40;

function AlbumRowImpl({ album, onPress }: Props) {
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
      subtitle={album.artist_name}
      trailing={`${album.track_count} ${album.track_count === 1 ? "track" : "tracks"}`}
    />
  );
}

export const AlbumRow = memo(AlbumRowImpl);
