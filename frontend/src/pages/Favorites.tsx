import { useEffect, useMemo } from "react";
import { Heart as HeartIcon, Play as PlayIcon } from "lucide-react";
import { Button } from "../components/Button";
import TrackList from "../components/TrackList";
import ListPageHeader from "../components/ListPageHeader";
import ErrorBanner from "../components/ErrorBanner";
import EmptyState from "../components/EmptyState";
import { useFavorites } from "../context/Favorites";
import { usePlayer } from "../context/Player";
import { pluralize } from "../lib/format";

export default function Favorites() {
  const { play } = usePlayer();
  // The favorites context loaded this list at sign-in: show it at once and
  // refresh it behind (it doesn't pick up hearts added since). Empty while
  // loading, or after a failed load, means not known yet -- not "no
  // favorites".
  const favorites = useFavorites();
  const { error, refresh } = favorites;
  const tracks =
    (favorites.loading || favorites.error) && favorites.tracks.length === 0
      ? null
      : favorites.tracks;
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hero = useMemo(() => tracks?.[0] ?? null, [tracks]);

  return (
    <div className="view" style={{ display: "grid", gap: 18 }}>
      <ListPageHeader
        kind="Collection"
        title="Favorites"
        heroTrack={hero}
        fallbackIcon={
          <HeartIcon className="size-12" style={{ color: "var(--muted-foreground)" }} />
        }
        meta={
          <>
            <span>{tracks ? pluralize(tracks.length, "track") : "—"}</span>
            <span className="dot" />
            <span>most recently favorited first</span>
          </>
        }
        actions={
          <Button
            variant="primary"
            disabled={!tracks || tracks.length === 0}
            onClick={() => tracks && tracks.length > 0 && play(tracks[0], tracks)}
            leadingIcon={<PlayIcon className="size-4" />}
          >
            Play all
          </Button>
        }
      />

      {error && <ErrorBanner message={error} />}
      {tracks && (
        <TrackList
          tracks={tracks}
          emptyState={
            <EmptyState
              title="No favorites yet."
              hint="Click the heart next to any track to add it here."
            />
          }
        />
      )}
    </div>
  );
}
